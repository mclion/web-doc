package handler

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/xiaofengguo/web-doc/api/internal/model"
)

// =============================================================================
// MCP Token 管理 REST API（供前端配置页使用）
// =============================================================================

type mcpTokenView struct {
	ID         string     `json:"id"`
	Name       string     `json:"name"`
	Token      string     `json:"token"` // 仅创建时返回明文，列表中返回掩码
	LastUsedAt *time.Time `json:"lastUsedAt,omitempty"`
	CreatedAt  time.Time  `json:"createdAt"`
}

func maskToken(t string) string {
	if len(t) <= 8 {
		return "••••"
	}
	return t[:4] + "••••••••" + t[len(t)-4:]
}

// ListMCPTokens 列出当前用户的 MCP Token（脱敏）
func (h *Handler) ListMCPTokens(c *gin.Context) {
	uid := getLocal(c, "userID")
	var rows []model.MCPToken
	if err := h.DB.Where("owner_id = ?", uid).Order("created_at desc").Find(&rows).Error; err != nil {
		serverError(c, err)
		return
	}
	out := make([]mcpTokenView, 0, len(rows))
	for _, r := range rows {
		out = append(out, mcpTokenView{
			ID: r.ID, Name: r.Name, Token: maskToken(r.Token),
			LastUsedAt: r.LastUsedAt, CreatedAt: r.CreatedAt,
		})
	}
	c.JSON(http.StatusOK, gin.H{"items": out})
}

// CreateMCPToken 生成一个新 Token（明文仅返回一次）
func (h *Handler) CreateMCPToken(c *gin.Context) {
	var req struct {
		Name string `json:"name"`
	}
	_ = c.ShouldBindJSON(&req)
	if strings.TrimSpace(req.Name) == "" {
		req.Name = "default"
	}
	tk := "wd_" + randomToken(24) // 48 hex chars + prefix
	row := model.MCPToken{
		ID:        uuid.NewString(),
		OwnerID:   getLocal(c, "userID"),
		Name:      req.Name,
		Token:     tk,
		CreatedAt: time.Now(),
	}
	if err := h.DB.Create(&row).Error; err != nil {
		serverError(c, err)
		return
	}
	c.JSON(http.StatusOK, mcpTokenView{
		ID: row.ID, Name: row.Name, Token: row.Token, // 明文
		CreatedAt: row.CreatedAt,
	})
}

// DeleteMCPToken 删除当前用户的一个 Token
func (h *Handler) DeleteMCPToken(c *gin.Context) {
	id := c.Param("id")
	uid := getLocal(c, "userID")
	if err := h.DB.Where("id = ? AND owner_id = ?", id, uid).Delete(&model.MCPToken{}).Error; err != nil {
		serverError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// authMCP 校验 Bearer Token；命中则更新 LastUsedAt（最佳努力），并返回该 Token 记录（含 OwnerID）。
func (h *Handler) authMCP(c *gin.Context) (model.MCPToken, error) {
	var row model.MCPToken
	auth := c.GetHeader("Authorization")
	if !strings.HasPrefix(auth, "Bearer ") {
		return row, errors.New("missing bearer token")
	}
	tk := strings.TrimSpace(strings.TrimPrefix(auth, "Bearer "))
	if tk == "" {
		return row, errors.New("empty token")
	}
	if err := h.DB.Where("token = ?", tk).First(&row).Error; err != nil {
		return row, errors.New("invalid token")
	}
	now := time.Now()
	h.DB.Model(&model.MCPToken{}).Where("id = ?", row.ID).Update("last_used_at", &now)
	return row, nil
}

// =============================================================================
// MCP Streamable HTTP Server (JSON-RPC 2.0, protocol 2025-03-26)
// 单一端点 POST /mcp ，每个请求一应答；无服务端 push。
// =============================================================================

const (
	mcpProtoVersion = "2025-03-26"
	mcpServerName   = "web-doc"
	mcpServerVer    = "0.1.0"
)

type rpcRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params,omitempty"`
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
	Data    any    `json:"data,omitempty"`
}

type rpcResponse struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Result  any             `json:"result,omitempty"`
	Error   *rpcError       `json:"error,omitempty"`
}

func rpcOK(id json.RawMessage, result any) rpcResponse {
	return rpcResponse{JSONRPC: "2.0", ID: id, Result: result}
}
func rpcFail(id json.RawMessage, code int, msg string) rpcResponse {
	return rpcResponse{JSONRPC: "2.0", ID: id, Error: &rpcError{Code: code, Message: msg}}
}

// MCPHandler 处理 POST /mcp
func (h *Handler) MCPHandler(c *gin.Context) {
	token, err := h.authMCP(c)
	if err != nil {
		c.Header("WWW-Authenticate", `Bearer realm="web-doc-mcp"`)
		c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": err.Error()})
		return
	}
	uid := token.OwnerID

	body, err := io.ReadAll(c.Request.Body)
	if err != nil {
		c.AbortWithStatusJSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if len(body) == 0 {
		c.AbortWithStatusJSON(http.StatusBadRequest, gin.H{"error": "empty body"})
		return
	}

	// 支持单个对象或批量数组
	trimmed := bytes.TrimSpace(body)
	if len(trimmed) > 0 && trimmed[0] == '[' {
		var batch []rpcRequest
		if err := json.Unmarshal(body, &batch); err != nil {
			c.AbortWithStatusJSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		out := make([]rpcResponse, 0, len(batch))
		for _, r := range batch {
			if resp, ok := h.dispatchMCP(r, uid); ok {
				out = append(out, resp)
			}
		}
		c.JSON(http.StatusOK, out)
		return
	}

	var req rpcRequest
	if err := json.Unmarshal(body, &req); err != nil {
		c.AbortWithStatusJSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	resp, ok := h.dispatchMCP(req, uid)
	if !ok {
		// notification（无 id）：返回 202
		c.Status(http.StatusAccepted)
		return
	}
	c.JSON(http.StatusOK, resp)
}

// dispatchMCP 路由 MCP 方法。uid 是本次请求所用 MCP Token 的所有者，用于限定文档访问范围。
// 返回 (response, hasResponse)；通知类请求 (id 为空) 返回 false。
func (h *Handler) dispatchMCP(req rpcRequest, uid string) (rpcResponse, bool) {
	hasID := len(req.ID) > 0 && string(req.ID) != "null"

	switch req.Method {
	case "initialize":
		return rpcOK(req.ID, gin.H{
			"protocolVersion": mcpProtoVersion,
			"capabilities": gin.H{
				"tools": gin.H{"listChanged": false},
			},
			"serverInfo": gin.H{
				"name":    mcpServerName,
				"version": mcpServerVer,
			},
			"instructions": "Web-Doc MCP server: 管理 HTML 文档（list/create/read/upload/delete）。文件路径基于文档目录的相对路径，常见入口为 index.html。",
		}), true

	case "notifications/initialized", "initialized":
		return rpcResponse{}, false

	case "ping":
		return rpcOK(req.ID, gin.H{}), true

	case "tools/list":
		return rpcOK(req.ID, gin.H{"tools": mcpToolsSpec()}), true

	case "tools/call":
		return h.mcpToolsCall(req, uid), true

	// 未实现的能力（resources/prompts）
	case "resources/list":
		return rpcOK(req.ID, gin.H{"resources": []any{}}), true
	case "prompts/list":
		return rpcOK(req.ID, gin.H{"prompts": []any{}}), true

	default:
		if !hasID {
			return rpcResponse{}, false
		}
		return rpcFail(req.ID, -32601, "method not found: "+req.Method), true
	}
}

// =============================================================================
// 工具规格
// =============================================================================

func mcpToolsSpec() []gin.H {
	return []gin.H{
		{
			"name":        "list_documents",
			"description": "列出所有文档与文件夹。返回扁平列表（含 parentId/type 字段），客户端可自行组装为树。",
			"inputSchema": gin.H{
				"type":       "object",
				"properties": gin.H{},
			},
		},
		{
			"name":        "get_document",
			"description": "获取单个文档（type=doc）的元信息和文件清单；type=folder 时仅返回元信息。",
			"inputSchema": gin.H{
				"type": "object",
				"properties": gin.H{
					"id": gin.H{"type": "string", "description": "文档或文件夹 ID"},
				},
				"required": []string{"id"},
			},
		},
		{
			"name":        "read_document_file",
			"description": "读取文档目录下指定文件的文本内容。仅适用于文本类（html/css/js/json/md/svg/...）。默认 path=index.html。",
			"inputSchema": gin.H{
				"type": "object",
				"properties": gin.H{
					"id":   gin.H{"type": "string", "description": "文档 ID"},
					"path": gin.H{"type": "string", "description": "相对文档目录的路径", "default": "index.html"},
				},
				"required": []string{"id"},
			},
		},
		{
			"name":        "create_document",
			"description": "创建一个新文档（type=doc）或文件夹（type=folder）。type=doc 时可传入 html 作为初始 index.html。返回新节点。",
			"inputSchema": gin.H{
				"type": "object",
				"properties": gin.H{
					"title":    gin.H{"type": "string", "description": "标题"},
					"type":     gin.H{"type": "string", "enum": []string{"doc", "folder"}, "default": "doc"},
					"parentId": gin.H{"type": "string", "description": "父文件夹 ID，可空"},
					"html":     gin.H{"type": "string", "description": "type=doc 时的初始 HTML 内容，可空"},
				},
				"required": []string{"title"},
			},
		},
		{
			"name":        "upload_html",
			"description": "为已存在的文档写入/覆盖单个文件（默认 index.html）。常用于 AI Agent 直接生成 HTML 后保存。",
			"inputSchema": gin.H{
				"type": "object",
				"properties": gin.H{
					"id":   gin.H{"type": "string", "description": "文档 ID"},
					"html": gin.H{"type": "string", "description": "完整文件文本"},
					"file": gin.H{"type": "string", "description": "文档目录下的相对路径", "default": "index.html"},
				},
				"required": []string{"id", "html"},
			},
		},
		{
			"name":        "upload_zip_base64",
			"description": "上传 base64 编码的 zip 压缩包，作为整站资源解压到文档目录（会替换原有文件）。zip 内允许的扩展名见服务端白名单。",
			"inputSchema": gin.H{
				"type": "object",
				"properties": gin.H{
					"id":     gin.H{"type": "string", "description": "文档 ID"},
					"zipB64": gin.H{"type": "string", "description": "zip 文件的 base64 编码字符串（不带 data: 前缀）"},
				},
				"required": []string{"id", "zipB64"},
			},
		},
		{
			"name":        "delete_document",
			"description": "删除一个文档或文件夹（文件夹会递归删除子节点和文件）。",
			"inputSchema": gin.H{
				"type": "object",
				"properties": gin.H{
					"id": gin.H{"type": "string", "description": "节点 ID"},
				},
				"required": []string{"id"},
			},
		},
	}
}

// =============================================================================
// 工具调用执行
// =============================================================================

func (h *Handler) mcpToolsCall(req rpcRequest, uid string) rpcResponse {
	var p struct {
		Name      string          `json:"name"`
		Arguments json.RawMessage `json:"arguments"`
	}
	if err := json.Unmarshal(req.Params, &p); err != nil {
		return rpcFail(req.ID, -32602, "invalid params: "+err.Error())
	}

	text, isErr := h.runMCPTool(p.Name, p.Arguments, uid)
	return rpcOK(req.ID, gin.H{
		"content": []gin.H{
			{"type": "text", "text": text},
		},
		"isError": isErr,
	})
}

func (h *Handler) runMCPTool(name string, raw json.RawMessage, uid string) (string, bool) {
	switch name {
	case "list_documents":
		return h.toolListDocuments(uid)
	case "get_document":
		return h.toolGetDocument(raw, uid)
	case "read_document_file":
		return h.toolReadDocumentFile(raw, uid)
	case "create_document":
		return h.toolCreateDocument(raw, uid)
	case "upload_html":
		return h.toolUploadHTML(raw, uid)
	case "upload_zip_base64":
		return h.toolUploadZipB64(raw, uid)
	case "delete_document":
		return h.toolDeleteDocument(raw, uid)
	default:
		return "unknown tool: " + name, true
	}
}

func toolJSON(v any) string {
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err.Error()
	}
	return string(b)
}

func toolErr(msg string) (string, bool) { return msg, true }

func (h *Handler) toolListDocuments(uid string) (string, bool) {
	var nodes []model.Node
	if err := h.DB.Where("owner_id = ?", uid).Order("type desc, sort_order asc, created_at asc").Find(&nodes).Error; err != nil {
		return toolErr(err.Error())
	}
	return toolJSON(gin.H{"items": nodes}), false
}

func (h *Handler) toolGetDocument(raw json.RawMessage, uid string) (string, bool) {
	var p struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(raw, &p); err != nil {
		return toolErr("invalid arguments: " + err.Error())
	}
	if p.ID == "" {
		return toolErr("id is required")
	}
	var n model.Node
	if err := h.DB.First(&n, "id = ?", p.ID).Error; err != nil || n.OwnerID != uid {
		return toolErr("not found")
	}
	if n.Type == "doc" {
		files, _ := h.Storage.ListFiles(n.ID)
		return toolJSON(gin.H{"node": n, "files": files}), false
	}
	return toolJSON(gin.H{"node": n}), false
}

func (h *Handler) toolReadDocumentFile(raw json.RawMessage, uid string) (string, bool) {
	var p struct {
		ID   string `json:"id"`
		Path string `json:"path"`
	}
	if err := json.Unmarshal(raw, &p); err != nil {
		return toolErr("invalid arguments: " + err.Error())
	}
	if p.ID == "" {
		return toolErr("id is required")
	}
	if p.Path == "" {
		p.Path = "index.html"
	}
	var n model.Node
	if err := h.DB.First(&n, "id = ? AND type = 'doc'", p.ID).Error; err != nil || n.OwnerID != uid {
		return toolErr("doc not found")
	}
	full, err := h.Storage.ResolveSafe(p.ID, p.Path)
	if err != nil {
		return toolErr("invalid path")
	}
	data, err := readFileSafe(full)
	if err != nil {
		return toolErr("file not found: " + p.Path)
	}
	return toolJSON(gin.H{"path": p.Path, "content": string(data)}), false
}

func (h *Handler) toolCreateDocument(raw json.RawMessage, uid string) (string, bool) {
	var p struct {
		Title    string  `json:"title"`
		Type     string  `json:"type"`
		ParentID *string `json:"parentId"`
		HTML     string  `json:"html"`
	}
	if err := json.Unmarshal(raw, &p); err != nil {
		return toolErr("invalid arguments: " + err.Error())
	}
	if strings.TrimSpace(p.Title) == "" {
		p.Title = "未命名"
	}
	if p.Type == "" {
		p.Type = "doc"
	}
	if p.Type != "doc" && p.Type != "folder" {
		return toolErr("type must be 'doc' or 'folder'")
	}
	if p.ParentID != nil && *p.ParentID != "" {
		var parent model.Node
		if err := h.DB.Select("id", "owner_id").First(&parent, "id = ?", *p.ParentID).Error; err != nil || parent.OwnerID != uid {
			return toolErr("parent folder not found")
		}
	}
	n := model.Node{
		ID:         uuid.NewString(),
		OwnerID:    uid,
		ParentID:   p.ParentID,
		Type:       p.Type,
		Title:      p.Title,
		EntryFile:  "index.html",
		Visibility: "private",
	}
	if p.Type == "doc" {
		if err := h.Storage.CreateDoc(n.ID, p.HTML); err != nil {
			return toolErr(err.Error())
		}
		h.Hub.AddDocWatch(h.Storage.DocPath(n.ID))
		n.SizeBytes = h.Storage.DocSize(n.ID)
	}
	if err := h.DB.Create(&n).Error; err != nil {
		return toolErr(err.Error())
	}
	return toolJSON(n), false
}

func (h *Handler) toolUploadHTML(raw json.RawMessage, uid string) (string, bool) {
	var p struct {
		ID   string `json:"id"`
		HTML string `json:"html"`
		File string `json:"file"`
	}
	if err := json.Unmarshal(raw, &p); err != nil {
		return toolErr("invalid arguments: " + err.Error())
	}
	if p.ID == "" {
		return toolErr("id is required")
	}
	if p.File == "" {
		p.File = "index.html"
	}
	var n model.Node
	if err := h.DB.First(&n, "id = ? AND type = 'doc'", p.ID).Error; err != nil || n.OwnerID != uid {
		return toolErr("doc not found")
	}
	if err := h.Storage.WriteFile(p.ID, p.File, []byte(p.HTML)); err != nil {
		return toolErr(err.Error())
	}
	n.SizeBytes = h.Storage.DocSize(p.ID)
	h.DB.Save(&n)
	return toolJSON(gin.H{"ok": true, "size": n.SizeBytes, "file": p.File}), false
}

func (h *Handler) toolUploadZipB64(raw json.RawMessage, uid string) (string, bool) {
	var p struct {
		ID     string `json:"id"`
		ZipB64 string `json:"zipB64"`
	}
	if err := json.Unmarshal(raw, &p); err != nil {
		return toolErr("invalid arguments: " + err.Error())
	}
	if p.ID == "" || p.ZipB64 == "" {
		return toolErr("id and zipB64 are required")
	}
	var n model.Node
	if err := h.DB.First(&n, "id = ? AND type = 'doc'", p.ID).Error; err != nil || n.OwnerID != uid {
		return toolErr("doc not found")
	}
	// 容忍 data:...;base64, 前缀
	b64 := p.ZipB64
	if i := strings.Index(b64, "base64,"); i >= 0 {
		b64 = b64[i+len("base64,"):]
	}
	data, err := base64.StdEncoding.DecodeString(b64)
	if err != nil {
		return toolErr("invalid base64: " + err.Error())
	}
	hasIndex, err := h.Storage.ExtractZip(p.ID, bytesReaderAt(data), int64(len(data)))
	if err != nil {
		return toolErr(err.Error())
	}
	n.SizeBytes = h.Storage.DocSize(p.ID)
	if hasIndex {
		n.EntryFile = "index.html"
	}
	h.DB.Save(&n)
	files, _ := h.Storage.ListFiles(p.ID)
	return toolJSON(gin.H{
		"ok":       true,
		"size":     n.SizeBytes,
		"hasIndex": hasIndex,
		"files":    files,
	}), false
}

func (h *Handler) toolDeleteDocument(raw json.RawMessage, uid string) (string, bool) {
	var p struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(raw, &p); err != nil {
		return toolErr("invalid arguments: " + err.Error())
	}
	if p.ID == "" {
		return toolErr("id is required")
	}
	var n model.Node
	if err := h.DB.First(&n, "id = ?", p.ID).Error; err != nil || n.OwnerID != uid {
		return toolErr("not found")
	}
	if err := h.deleteNodeTree(n); err != nil {
		return toolErr(err.Error())
	}
	if err := h.DB.Delete(&n).Error; err != nil {
		return toolErr(err.Error())
	}
	return toolJSON(gin.H{"ok": true}), false
}
