package handler

import (
	"errors"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/xiaofengguo/web-doc/api/internal/auth"
	"github.com/xiaofengguo/web-doc/api/internal/model"
	"gorm.io/gorm"
)

const tokenTTL = 7 * 24 * time.Hour

// authCookieName 承载与 Bearer 相同的 JWT，仅供 <iframe>/WebSocket 这类无法附带
// Authorization 头的同源请求使用（浏览器会自动带上 Cookie）。HttpOnly，前端 JS 不需要读它——
// 前端自己的鉴权仍然走 localStorage + Authorization 头。
const authCookieName = "webdoc_token"

// setAuthCookie / clearAuthCookie 维护 authCookieName。isSecureRequest 判断当前请求是否经由
// HTTPS（直连或被反代 X-Forwarded-Proto 标记），本地 HTTP 开发环境下自动降级为非 Secure，
// 否则浏览器会直接丢弃该 Cookie。
func isSecureRequest(c *gin.Context) bool {
	return c.Request.TLS != nil || strings.EqualFold(c.GetHeader("X-Forwarded-Proto"), "https")
}

func setAuthCookie(c *gin.Context, tok string) {
	c.SetCookie(authCookieName, tok, int(tokenTTL.Seconds()), "/", "", isSecureRequest(c), true)
}

func clearAuthCookie(c *gin.Context) {
	c.SetCookie(authCookieName, "", -1, "/", "", isSecureRequest(c), true)
}

var (
	usernameRe = regexp.MustCompile(`^[a-zA-Z0-9_]{3,32}$`)
	emailRe    = regexp.MustCompile(`^[^@\s]+@[^@\s]+\.[^@\s]+$`)
)

// ============== 注册 ==============

type registerReq struct {
	Username    string `json:"username"`
	Password    string `json:"password"`
	Email       string `json:"email"`
	DisplayName string `json:"displayName"`
}

func (h *Handler) AuthRegister(c *gin.Context) {
	if h.DisableRegister {
		c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"error": "注册已关闭，请联系管理员"})
		return
	}
	var req registerReq
	if err := c.ShouldBindJSON(&req); err != nil {
		badRequest(c, err.Error())
		return
	}
	req.Username = strings.TrimSpace(req.Username)
	req.Email = strings.TrimSpace(req.Email)
	req.DisplayName = strings.TrimSpace(req.DisplayName)
	if !usernameRe.MatchString(req.Username) {
		badRequest(c, "用户名需 3-32 位字母/数字/下划线")
		return
	}
	if len(req.Password) < 6 {
		badRequest(c, "密码至少 6 位")
		return
	}
	if req.Email != "" && !emailRe.MatchString(req.Email) {
		badRequest(c, "邮箱格式不正确")
		return
	}

	// 唯一性校验
	var exist model.User
	if err := h.DB.Where("username = ?", req.Username).First(&exist).Error; err == nil {
		c.AbortWithStatusJSON(http.StatusConflict, gin.H{"error": "用户名已存在"})
		return
	} else if !errors.Is(err, gorm.ErrRecordNotFound) {
		serverError(c, err)
		return
	}
	if req.Email != "" {
		if err := h.DB.Where("email = ?", req.Email).First(&exist).Error; err == nil {
			c.AbortWithStatusJSON(http.StatusConflict, gin.H{"error": "邮箱已注册"})
			return
		} else if !errors.Is(err, gorm.ErrRecordNotFound) {
			serverError(c, err)
			return
		}
	}

	hash, err := auth.HashPassword(req.Password)
	if err != nil {
		serverError(c, err)
		return
	}

	// 首位用户自动 admin
	var count int64
	h.DB.Model(&model.User{}).Count(&count)
	role := "user"
	if count == 0 {
		role = "admin"
	}

	u := model.User{
		ID:           uuid.NewString(),
		Username:     req.Username,
		Email:        req.Email,
		PasswordHash: hash,
		DisplayName:  req.DisplayName,
		Role:         role,
	}
	if err := h.DB.Create(&u).Error; err != nil {
		serverError(c, err)
		return
	}

	tok, err := h.signUserToken(&u)
	if err != nil {
		serverError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"user": publicUser(&u), "token": tok})
}

// ============== 登录 ==============

type loginReq struct {
	Username string `json:"username"` // 用户名 或 邮箱
	Password string `json:"password"`
}

func (h *Handler) AuthLogin(c *gin.Context) {
	var req loginReq
	if err := c.ShouldBindJSON(&req); err != nil {
		badRequest(c, err.Error())
		return
	}
	id := strings.TrimSpace(req.Username)
	if id == "" || req.Password == "" {
		badRequest(c, "请输入用户名/邮箱与密码")
		return
	}

	var u model.User
	q := h.DB.Where("username = ?", id)
	if strings.Contains(id, "@") {
		q = h.DB.Where("username = ? OR email = ?", id, id)
	}
	if err := q.First(&u).Error; err != nil {
		c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "账号或密码错误"})
		return
	}
	if !auth.CheckPassword(u.PasswordHash, req.Password) {
		c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "账号或密码错误"})
		return
	}
	tok, err := h.signUserToken(&u)
	if err != nil {
		serverError(c, err)
		return
	}
	setAuthCookie(c, tok)
	c.JSON(http.StatusOK, gin.H{"user": publicUser(&u), "token": tok})
}

// ============== 登出 ==============

// AuthLogout 仅清除 authCookieName；前端自己的 localStorage token 由前端负责清理。
func (h *Handler) AuthLogout(c *gin.Context) {
	clearAuthCookie(c)
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// ============== 当前用户 ==============

func (h *Handler) AuthMe(c *gin.Context) {
	uid := getLocal(c, "userID")
	if uid == "" {
		c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "未登录"})
		return
	}
	var u model.User
	if err := h.DB.First(&u, "id = ?", uid).Error; err != nil {
		c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "未登录"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"user": publicUser(&u)})
}

// ============== 公共信息：注册是否开放 ==============

func (h *Handler) AuthPublicInfo(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{
		"registerEnabled": !h.DisableRegister,
	})
}

// ============== 中间件 ==============

// AuthRequired 强制要求登录；解析 Bearer Token，写入 c.Keys
func (h *Handler) AuthRequired(c *gin.Context) {
	uid := h.parseBearer(c)
	if uid == "" {
		c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "请先登录"})
		return
	}
	c.Next()
}

// AuthOptional 解析但不强制
func (h *Handler) AuthOptional(c *gin.Context) {
	h.parseBearer(c)
	c.Next()
}

// RequireAdmin 要求当前用户角色为 admin；必须放在 AuthRequired 之后。
func (h *Handler) RequireAdmin(c *gin.Context) {
	if getLocal(c, "role") != "admin" {
		c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"error": "需要管理员权限"})
		return
	}
	c.Next()
}

// resolveUID 返回当前请求对应的用户 ID：优先用 AuthOptional 已经从 Authorization 头解析好的
// 结果；如果没有（典型场景：<iframe>/WebSocket 请求无法携带自定义头，但同源 Cookie 会自动
// 带上），则回退校验 authCookieName。仅用于只读的静态资源/推送类接口（ServeDocAsset、WSDocWatch）。
func (h *Handler) resolveUID(c *gin.Context) string {
	if uid := getLocal(c, "userID"); uid != "" {
		return uid
	}
	tok, err := c.Cookie(authCookieName)
	if err != nil || tok == "" {
		return ""
	}
	cs, err := auth.VerifyToken(h.JWTSecret, tok)
	if err != nil {
		return ""
	}
	return cs.Sub
}

func (h *Handler) parseBearer(c *gin.Context) string {
	header := c.GetHeader("Authorization")
	if header == "" {
		return ""
	}
	tk := strings.TrimSpace(strings.TrimPrefix(header, "Bearer "))
	if tk == "" || tk == header { // 没带 Bearer 前缀也允许
		tk = strings.TrimSpace(header)
	}
	if tk == "" {
		return ""
	}
	cs, err := auth.VerifyToken(h.JWTSecret, tk)
	if err != nil {
		return ""
	}
	c.Set("userID", cs.Sub)
	c.Set("username", cs.Username)
	c.Set("role", cs.Role)
	return cs.Sub
}

// ============== 工具 ==============

func (h *Handler) signUserToken(u *model.User) (string, error) {
	return auth.SignToken(h.JWTSecret, auth.Claims{
		Sub:      u.ID,
		Username: u.Username,
		Role:     u.Role,
	}, tokenTTL)
}

type publicUserView struct {
	ID          string    `json:"id"`
	Username    string    `json:"username"`
	Email       string    `json:"email,omitempty"`
	DisplayName string    `json:"displayName,omitempty"`
	Role        string    `json:"role"`
	CreatedAt   time.Time `json:"createdAt"`
}

func publicUser(u *model.User) publicUserView {
	return publicUserView{
		ID: u.ID, Username: u.Username, Email: u.Email,
		DisplayName: u.DisplayName, Role: u.Role, CreatedAt: u.CreatedAt,
	}
}
