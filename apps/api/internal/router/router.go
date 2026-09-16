package router

import (
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/gin-contrib/cors"
	"github.com/gin-gonic/gin"
	"github.com/xiaofengguo/web-doc/api/internal/config"
	"github.com/xiaofengguo/web-doc/api/internal/handler"
)

// New 构建完整的路由表。main.go 和测试都通过这里获取同一份路由，避免路由定义漂移。
func New(h *handler.Handler, cfg *config.Config) *gin.Engine {
	gin.SetMode(gin.ReleaseMode)
	app := gin.New()
	app.Use(gin.Recovery())
	app.Use(gin.Logger())

	// Body 上限：在 handler 里通过 MaxBytesReader 控制；这里设置一个较宽松的全局值
	app.MaxMultipartMemory = int64(cfg.MaxUploadMB) * 1024 * 1024

	// CORS
	allowOrigins := splitAndTrim(cfg.AllowOrigin)
	allowAll := len(allowOrigins) == 0 || (len(allowOrigins) == 1 && allowOrigins[0] == "*")
	corsCfg := cors.Config{
		AllowMethods:     []string{"GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"},
		AllowHeaders:     []string{"Origin", "Content-Type", "Accept", "Authorization"},
		ExposeHeaders:    []string{"Content-Length", "Content-Type"},
		AllowCredentials: false,
		MaxAge:           12 * time.Hour,
	}
	if allowAll {
		corsCfg.AllowAllOrigins = true
	} else {
		corsCfg.AllowOrigins = allowOrigins
	}
	app.Use(cors.New(corsCfg))

	// 健康检查
	app.GET("/healthz", func(c *gin.Context) { c.String(http.StatusOK, "ok") })

	// 全局可选鉴权（解析 Token，便于后续接口取用户信息；不强制）
	app.Use(h.AuthOptional)

	// 鉴权（公开 + 受保护）
	app.GET("/api/auth/public-info", h.AuthPublicInfo)
	app.POST("/api/auth/register", h.AuthRegister)
	app.POST("/api/auth/login", h.AuthLogin)
	app.GET("/api/auth/me", h.AuthRequired, h.AuthMe)

	api := app.Group("/api")

	// 分享只读入口：保持公开/匿名可访问
	api.GET("/shares/:token", h.GetShareInfo)

	// 节点/文档读写：必须登录，按 owner 隔离（在各 handler 内部完成过滤）
	authAPI := api.Group("", h.AuthRequired)
	authAPI.GET("/nodes", h.ListNodes)
	authAPI.POST("/nodes", h.CreateNode)
	authAPI.GET("/nodes/:id", h.GetNode)
	authAPI.PATCH("/nodes/:id", h.UpdateNode)
	authAPI.DELETE("/nodes/:id", h.DeleteNode)

	authAPI.POST("/docs/:id/html", h.UploadHTML)
	authAPI.POST("/docs/:id/zip", h.UploadZip)
	authAPI.GET("/docs/:id/file", h.GetFileContent)
	authAPI.POST("/docs/:id/file", h.SaveFile)

	authAPI.POST("/docs/:id/share", h.CreateShare)

	// 节点拖拽排序 / 移动
	authAPI.PATCH("/nodes/reorder/batch", h.ReorderNodes)

	// AI 设置 + 生成（必须登录）
	aiGroup := api.Group("/ai", h.AuthRequired)
	aiGroup.GET("/settings", h.GetAISettings)
	aiGroup.PATCH("/settings", h.UpdateAISettings)
	aiGroup.POST("/generate", h.AIGenerate)

	// AI Prompt 模板管理（必须登录）
	aiGroup.GET("/prompts", h.ListPrompts)
	aiGroup.POST("/prompts", h.CreatePrompt)
	aiGroup.PATCH("/prompts/:id", h.UpdatePrompt)
	aiGroup.DELETE("/prompts/:id", h.DeletePrompt)

	// MCP Token 管理（必须登录；每个用户只能管理自己的 Token）
	mcpAdmin := api.Group("/mcp", h.AuthRequired)
	mcpAdmin.GET("/tokens", h.ListMCPTokens)
	mcpAdmin.POST("/tokens", h.CreateMCPToken)
	mcpAdmin.DELETE("/tokens/:id", h.DeleteMCPToken)

	// 管理员：用户管理
	adminGroup := api.Group("/admin", h.AuthRequired, h.RequireAdmin)
	adminGroup.GET("/users", h.AdminListUsers)
	adminGroup.POST("/users", h.AdminCreateUser)
	adminGroup.PATCH("/users/:id", h.AdminUpdateUser)
	adminGroup.DELETE("/users/:id", h.AdminDeleteUser)

	// MCP Streamable HTTP 端点（JSON-RPC 2.0；通过 Bearer Token 鉴权）
	app.POST("/mcp", h.MCPHandler)

	// 静态资源（独立路径，建议生产部署到独立子域名）；owner/public 校验在 handler 内部完成
	app.GET("/d/:id/*path", h.ServeDocAsset)

	// WebSocket：文档变更推送
	app.GET("/ws/docs/:id", h.WSDocWatch)

	// 前端静态资源（SPA），放在所有 API 路由之后
	if cfg.WebRoot != "" {
		mountFrontend(app, cfg.WebRoot)
	}

	return app
}

// splitAndTrim 将逗号分隔的字符串拆分并去空白。
func splitAndTrim(s string) []string {
	if s == "" {
		return nil
	}
	parts := strings.Split(s, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		p = strings.TrimSpace(p)
		if p != "" {
			out = append(out, p)
		}
	}
	return out
}

// mountFrontend 把前端构建产物挂载到根路径，并支持 SPA fallback：
// 当请求的文件不存在时，回落到 index.html，由前端路由处理。
func mountFrontend(app *gin.Engine, webRoot string) {
	if _, err := os.Stat(webRoot); err != nil {
		log.Printf("[web-doc] WARN: web root not found: %v", err)
		return
	}
	indexPath := filepath.Join(webRoot, "index.html")

	// API/资源前缀：这些路径不应被 SPA fallback 拦截
	backendPrefixes := []string{"/api", "/d/", "/ws", "/healthz", "/mcp"}

	app.NoRoute(func(c *gin.Context) {
		p := c.Request.URL.Path
		for _, pre := range backendPrefixes {
			if strings.HasPrefix(p, pre) {
				c.AbortWithStatus(http.StatusNotFound)
				return
			}
		}
		// 仅对 GET / HEAD 做 SPA fallback；其它方法保持 404
		if c.Request.Method != http.MethodGet && c.Request.Method != http.MethodHead {
			c.AbortWithStatus(http.StatusNotFound)
			return
		}

		// 优先尝试返回真实静态文件，找不到则回落 index.html
		clean := strings.TrimPrefix(p, "/")
		if clean == "" {
			c.File(indexPath)
			return
		}
		full := filepath.Join(webRoot, clean)
		// 安全：确保最终路径仍位于 webRoot 内
		absRoot, _ := filepath.Abs(webRoot)
		absFull, _ := filepath.Abs(full)
		if !strings.HasPrefix(absFull, absRoot) {
			c.AbortWithStatus(http.StatusForbidden)
			return
		}
		if info, err := os.Stat(full); err == nil && !info.IsDir() {
			c.File(full)
			return
		}
		c.File(indexPath)
	})
}
