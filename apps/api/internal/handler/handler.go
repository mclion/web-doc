package handler

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"io"
	"io/fs"
	"log"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/gorilla/websocket"
	"github.com/xiaofengguo/web-doc/api/internal/model"
	"github.com/xiaofengguo/web-doc/api/internal/storage"
	"github.com/xiaofengguo/web-doc/api/internal/watcher"
	"gorm.io/gorm"
)

type Handler struct {
	DB              *gorm.DB
	Storage         *storage.Storage
	Hub             *watcher.Hub
	JWTSecret       string
	DisableRegister bool

	wsUpgrader websocket.Upgrader
}

func New(db *gorm.DB, st *storage.Storage, hub *watcher.Hub) *Handler {
	return &Handler{
		DB: db, Storage: st, Hub: hub,
		wsUpgrader: websocket.Upgrader{
			ReadBufferSize:  1024,
			WriteBufferSize: 1024,
			// 跨域 WS 由前置网关/CORS 控制；这里允许任意来源升级。
			CheckOrigin: func(r *http.Request) bool { return true },
		},
	}
}

// ---------- 节点（文件夹/文档）管理 ----------

type createNodeReq struct {
	ParentID *string `json:"parentId"`
	Type     string  `json:"type"` // folder | doc
	Title    string  `json:"title"`
	HTML     string  `json:"html"` // 仅 type=doc 时使用，纯 HTML 源码
}

func (h *Handler) CreateNode(c *gin.Context) {
	var req createNodeReq
	if err := c.ShouldBindJSON(&req); err != nil {
		badRequest(c, err.Error())
		return
	}
	if req.Type != "folder" && req.Type != "doc" {
		badRequest(c, "type must be folder or doc")
		return
	}
	if strings.TrimSpace(req.Title) == "" {
		req.Title = "未命名"
	}
	uid := getLocal(c, "userID")
	if req.ParentID != nil && *req.ParentID != "" {
		var parent model.Node
		if err := h.DB.Select("id", "owner_id").First(&parent, "id = ?", *req.ParentID).Error; err != nil || parent.OwnerID != uid {
			notFound(c)
			return
		}
	}
	n := model.Node{
		ID:         uuid.NewString(),
		OwnerID:    uid,
		ParentID:   req.ParentID,
		Type:       req.Type,
		Title:      req.Title,
		EntryFile:  "index.html",
		Visibility: "private",
	}
	if req.Type == "doc" {
		if err := h.Storage.CreateDoc(n.ID, req.HTML); err != nil {
			serverError(c, err)
			return
		}
		h.Hub.AddDocWatch(h.Storage.DocPath(n.ID))
		n.SizeBytes = h.Storage.DocSize(n.ID)
	}
	if err := h.DB.Create(&n).Error; err != nil {
		serverError(c, err)
		return
	}
	c.JSON(http.StatusOK, n)
}

func (h *Handler) ListNodes(c *gin.Context) {
	uid := getLocal(c, "userID")
	var nodes []model.Node
	if err := h.DB.Where("owner_id = ?", uid).Order("type desc, sort_order asc, created_at asc").Find(&nodes).Error; err != nil {
		log.Printf("[web-doc api] ListNodes failed path=%s userID=%q username=%q error=%v", c.Request.URL.RequestURI(), getLocal(c, "userID"), getLocal(c, "username"), err)
		serverError(c, err)
		return
	}
	ids := make([]string, 0, len(nodes))
	for _, n := range nodes {
		if n.Type == "doc" {
			ids = append(ids, n.ID)
		}
	}
	log.Printf("[web-doc api] ListNodes ok path=%s userID=%q username=%q total=%d docIDs=%v", c.Request.URL.RequestURI(), getLocal(c, "userID"), getLocal(c, "username"), len(nodes), ids)
	c.JSON(http.StatusOK, gin.H{"items": nodes})
}

func (h *Handler) GetNode(c *gin.Context) {
	id := c.Param("id")
	n, ok := h.loadViewableNode(c, id, false)
	if !ok {
		log.Printf("[web-doc api] GetNode not found/forbidden path=%s id=%q userID=%q username=%q", c.Request.URL.RequestURI(), id, getLocal(c, "userID"), getLocal(c, "username"))
		return
	}
	if n.Type == "doc" {
		files, _ := h.Storage.ListFiles(n.ID)
		log.Printf("[web-doc api] GetNode ok path=%s id=%q title=%q type=%q visibility=%q userID=%q username=%q files=%v", c.Request.URL.RequestURI(), n.ID, n.Title, n.Type, n.Visibility, getLocal(c, "userID"), getLocal(c, "username"), files)
		c.JSON(http.StatusOK, gin.H{"node": n, "files": files})
		return
	}
	log.Printf("[web-doc api] GetNode ok path=%s id=%q title=%q type=%q visibility=%q userID=%q username=%q", c.Request.URL.RequestURI(), n.ID, n.Title, n.Type, n.Visibility, getLocal(c, "userID"), getLocal(c, "username"))
	c.JSON(http.StatusOK, gin.H{"node": n})
}

type updateNodeReq struct {
	Title      *string `json:"title"`
	ParentID   *string `json:"parentId"`
	Visibility *string `json:"visibility"`
	EntryFile  *string `json:"entryFile"`
}

func (h *Handler) UpdateNode(c *gin.Context) {
	id := c.Param("id")
	n, ok := h.loadOwnedNode(c, id, false)
	if !ok {
		return
	}
	var req updateNodeReq
	if err := c.ShouldBindJSON(&req); err != nil {
		badRequest(c, err.Error())
		return
	}
	if req.Title != nil {
		n.Title = *req.Title
	}
	if req.ParentID != nil {
		// 允许 ParentID 为 "" 表示移到根目录
		if *req.ParentID == "" {
			n.ParentID = nil
		} else {
			pid := *req.ParentID
			n.ParentID = &pid
		}
	}
	if req.Visibility != nil {
		n.Visibility = *req.Visibility
	}
	if req.EntryFile != nil {
		n.EntryFile = *req.EntryFile
	}
	if err := h.DB.Save(&n).Error; err != nil {
		serverError(c, err)
		return
	}
	c.JSON(http.StatusOK, n)
}

func (h *Handler) DeleteNode(c *gin.Context) {
	id := c.Param("id")
	n, ok := h.loadOwnedNode(c, id, false)
	if !ok {
		return
	}
	if err := h.deleteNodeTree(n); err != nil {
		serverError(c, err)
		return
	}
	if err := h.DB.Delete(&n).Error; err != nil {
		serverError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// deleteNodeTree 删除一个节点自身持有的内容：文件夹递归删除子节点；文档删除存储文件与分享记录。
// 不删除节点自身的 DB 行——调用方负责（DeleteNode / 管理员级联删除用户时各自决定是否软删除该行）。
func (h *Handler) deleteNodeTree(n model.Node) error {
	if n.Type == "folder" {
		return h.deleteRecursive(n.ID)
	}
	_ = h.Storage.RemoveDoc(n.ID)
	return h.DB.Where("doc_id = ?", n.ID).Delete(&model.Share{}).Error
}

func (h *Handler) deleteRecursive(parentID string) error {
	var children []model.Node
	if err := h.DB.Where("parent_id = ?", parentID).Find(&children).Error; err != nil {
		return err
	}
	for _, ch := range children {
		if ch.Type == "folder" {
			if err := h.deleteRecursive(ch.ID); err != nil {
				return err
			}
		} else {
			_ = h.Storage.RemoveDoc(ch.ID)
			h.DB.Where("doc_id = ?", ch.ID).Delete(&model.Share{})
		}
		if err := h.DB.Delete(&ch).Error; err != nil {
			return err
		}
	}
	return nil
}

// ---------- 文档内容上传 / 单文件读写 ----------

// UploadHTML 直接保存 HTML 源码到 index.html
type uploadHTMLReq struct {
	HTML string `json:"html"`
	File string `json:"file"` // 默认 index.html
}

func (h *Handler) UploadHTML(c *gin.Context) {
	id := c.Param("id")
	n, ok := h.loadOwnedNode(c, id, true)
	if !ok {
		return
	}
	var req uploadHTMLReq
	if err := c.ShouldBindJSON(&req); err != nil {
		badRequest(c, err.Error())
		return
	}
	file := req.File
	if file == "" {
		file = "index.html"
	}
	if err := h.Storage.WriteFile(id, file, []byte(req.HTML)); err != nil {
		serverError(c, err)
		return
	}
	n.SizeBytes = h.Storage.DocSize(id)
	h.DB.Save(&n)
	c.JSON(http.StatusOK, gin.H{"ok": true, "size": n.SizeBytes})
}

// UploadZip 上传 zip 解压到文档目录
func (h *Handler) UploadZip(c *gin.Context) {
	id := c.Param("id")
	n, ok := h.loadOwnedNode(c, id, true)
	if !ok {
		return
	}
	fh, err := c.FormFile("file")
	if err != nil {
		badRequest(c, "missing file")
		return
	}
	f, err := fh.Open()
	if err != nil {
		serverError(c, err)
		return
	}
	defer f.Close()
	data, err := io.ReadAll(f)
	if err != nil {
		serverError(c, err)
		return
	}
	hasIndex, err := h.Storage.ExtractZip(id, bytesReaderAt(data), int64(len(data)))
	if err != nil {
		badRequest(c, err.Error())
		return
	}
	n.SizeBytes = h.Storage.DocSize(id)
	// 如果用户已经设置过 entryFile 且文件存在，则直接沿用；否则若顶层无 index.html，告诉前端需要选择入口
	files, _ := h.Storage.ListFiles(id)
	needsEntry := false
	if !hasIndex {
		// 当前 entryFile 是否仍然有效
		if !h.Storage.FileExists(id, n.EntryFile) {
			needsEntry = true
		}
	} else {
		// 顶层有 index.html：自动设为 entry
		n.EntryFile = "index.html"
	}
	h.DB.Save(&n)
	c.JSON(http.StatusOK, gin.H{
		"ok":         true,
		"size":       n.SizeBytes,
		"hasIndex":   hasIndex,
		"needsEntry": needsEntry,
		"files":      files,
	})
}

// GetFileContent 读取文档下指定文件文本内容（用于编辑器）
func (h *Handler) GetFileContent(c *gin.Context) {
	id := c.Param("id")
	if _, ok := h.loadViewableNode(c, id, true); !ok {
		return
	}
	sub := c.DefaultQuery("path", "index.html")
	full, err := h.Storage.ResolveSafe(id, sub)
	if err != nil {
		badRequest(c, "invalid path")
		return
	}
	data, err := readFileSafe(full)
	if err != nil {
		notFound(c)
		return
	}
	c.JSON(http.StatusOK, gin.H{"path": sub, "content": string(data)})
}

// ---------- 静态资源服务 (/d/:id/*path) ----------

func (h *Handler) ServeDocAsset(c *gin.Context) {
	id := c.Param("id")
	sub := strings.TrimPrefix(c.Param("path"), "/")
	// 兼容历史行为：访问 /d/:id 或 /d/:id/ 时重定向到 index.html
	if sub == "" {
		c.Redirect(http.StatusFound, "/d/"+id+"/index.html")
		return
	}
	var n model.Node
	if err := h.DB.First(&n, "id = ? AND type = 'doc'", id).Error; err != nil {
		c.String(http.StatusNotFound, "Not Found")
		return
	}
	uid := getLocal(c, "userID")
	if n.Visibility != "public" && (uid == "" || n.OwnerID != uid) {
		c.String(http.StatusNotFound, "Not Found")
		return
	}
	full, err := h.Storage.ResolveSafe(id, sub)
	if err != nil {
		c.String(http.StatusBadRequest, "invalid path")
		return
	}
	// 设置 MIME 类型
	ext := strings.ToLower(filepath.Ext(full))
	if ct := mime.TypeByExtension(ext); ct != "" {
		c.Header("Content-Type", ct)
	}
	// 安全头：不允许被同源以外的 iframe 嵌入主站
	c.Header("X-Content-Type-Options", "nosniff")
	c.Header("Referrer-Policy", "no-referrer")
	// 禁用浏览器/中间层缓存：文档内容会被实时编辑，必须每次拿最新版本
	c.Header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
	c.Header("Pragma", "no-cache")
	c.Header("Expires", "0")
	// 直接读文件并写入响应，确保拿到最新内容（避免任何中间缓存层）
	data, err := os.ReadFile(full)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			c.String(http.StatusNotFound, "Not Found")
			return
		}
		log.Printf("[ServeDocAsset] read file failed id=%s sub=%s err=%v", id, sub, err)
		c.String(http.StatusInternalServerError, "read failed")
		return
	}
	c.Status(http.StatusOK)
	_, _ = c.Writer.Write(data)
}

// ---------- 分享 ----------

func (h *Handler) CreateShare(c *gin.Context) {
	id := c.Param("id")
	n, ok := h.loadOwnedNode(c, id, true)
	if !ok {
		return
	}
	if n.Visibility != "public" {
		n.Visibility = "public"
		if err := h.DB.Save(&n).Error; err != nil {
			serverError(c, err)
			return
		}
	}
	// 复用已有未过期分享
	var existing model.Share
	if err := h.DB.Where("doc_id = ?", id).First(&existing).Error; err == nil {
		c.JSON(http.StatusOK, existing)
		return
	}
	tk := randomToken(12)
	s := model.Share{
		ID:        uuid.NewString(),
		DocID:     id,
		Token:     tk,
		CreatedAt: time.Now(),
	}
	if err := h.DB.Create(&s).Error; err != nil {
		serverError(c, err)
		return
	}
	c.JSON(http.StatusOK, s)
}

// GetShareInfo 通过 token 取得文档信息（前端 /s/:token 用）
func (h *Handler) GetShareInfo(c *gin.Context) {
	token := c.Param("token")
	var s model.Share
	if err := h.DB.Where("token = ?", token).First(&s).Error; err != nil {
		log.Printf("[web-doc api] GetShareInfo share not found path=%s token=%q userID=%q username=%q error=%v", c.Request.URL.RequestURI(), token, getLocal(c, "userID"), getLocal(c, "username"), err)
		notFound(c)
		return
	}
	var n model.Node
	if err := h.DB.First(&n, "id = ?", s.DocID).Error; err != nil {
		log.Printf("[web-doc api] GetShareInfo doc not found path=%s token=%q docID=%q userID=%q username=%q error=%v", c.Request.URL.RequestURI(), token, s.DocID, getLocal(c, "userID"), getLocal(c, "username"), err)
		notFound(c)
		return
	}
	log.Printf("[web-doc api] GetShareInfo ok path=%s token=%q shareID=%q docID=%q title=%q visibility=%q userID=%q username=%q", c.Request.URL.RequestURI(), token, s.ID, n.ID, n.Title, n.Visibility, getLocal(c, "userID"), getLocal(c, "username"))
	c.JSON(http.StatusOK, gin.H{
		"share": s,
		"doc":   n,
	})
}

// ---------- WebSocket 监听文档变更 ----------

func (h *Handler) WSDocWatch(c *gin.Context) {
	docID := c.Param("id")
	var n model.Node
	if err := h.DB.First(&n, "id = ? AND type = 'doc'", docID).Error; err != nil {
		c.AbortWithStatus(http.StatusNotFound)
		return
	}
	uid := getLocal(c, "userID")
	if n.Visibility != "public" && (uid == "" || n.OwnerID != uid) {
		c.AbortWithStatus(http.StatusNotFound)
		return
	}
	conn, err := h.wsUpgrader.Upgrade(c.Writer, c.Request, nil)
	if err != nil {
		// Upgrade 失败时它内部已写过响应；这里只记录日志
		log.Printf("[web-doc ws] upgrade failed docID=%s err=%v", docID, err)
		return
	}
	defer conn.Close()

	ch := h.Hub.Subscribe(docID)
	defer h.Hub.Unsubscribe(docID, ch)

	// 单独 goroutine 读，避免 Conn 阻塞被关闭
	done := make(chan struct{})
	go func() {
		for {
			if _, _, err := conn.ReadMessage(); err != nil {
				close(done)
				return
			}
		}
	}()

	for {
		select {
		case <-done:
			return
		case ev := <-ch:
			if ev == "" {
				return
			}
			if err := conn.WriteJSON(gin.H{"type": ev}); err != nil {
				return
			}
		}
	}
}

// ---------- 所有权校验 ----------

// loadOwnedNode 按 id 查找节点，并校验其属于当前登录用户；不属于/不存在时统一返回 404
// （不用 403，避免向调用方泄露该 id 是否存在）。docOnly 为 true 时仅匹配 type='doc'。
// 用于写操作（改名/删除/上传/分享等）——分享出去的公开文档也不能被非所有者修改。
func (h *Handler) loadOwnedNode(c *gin.Context, id string, docOnly bool) (model.Node, bool) {
	var n model.Node
	q := h.DB
	if docOnly {
		q = q.Where("type = 'doc'")
	}
	if err := q.First(&n, "id = ?", id).Error; err != nil {
		notFound(c)
		return n, false
	}
	uid := getLocal(c, "userID")
	if uid == "" || n.OwnerID != uid {
		notFound(c)
		return n, false
	}
	return n, true
}

// loadViewableNode 与 loadOwnedNode 类似，但用于只读接口：所有者或者已公开（visibility=public）
// 的节点都可以读取，未登录的匿名访客访问分享出去的文档正是走这条路径（配合路由不挂 AuthRequired）。
func (h *Handler) loadViewableNode(c *gin.Context, id string, docOnly bool) (model.Node, bool) {
	var n model.Node
	q := h.DB
	if docOnly {
		q = q.Where("type = 'doc'")
	}
	if err := q.First(&n, "id = ?", id).Error; err != nil {
		notFound(c)
		return n, false
	}
	uid := getLocal(c, "userID")
	if n.Visibility != "public" && (uid == "" || n.OwnerID != uid) {
		notFound(c)
		return n, false
	}
	return n, true
}

// ---------- 工具函数 ----------

func badRequest(c *gin.Context, msg string) {
	c.AbortWithStatusJSON(http.StatusBadRequest, gin.H{"error": msg})
}
func notFound(c *gin.Context) {
	c.AbortWithStatusJSON(http.StatusNotFound, gin.H{"error": "not found"})
}
func serverError(c *gin.Context, err error) {
	c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
}

// getLocal 等价于 fiber 的 c.Locals("xxx")，统一返回 string（便于日志格式化）。
func getLocal(c *gin.Context, key string) string {
	if v, ok := c.Get(key); ok {
		if s, ok := v.(string); ok {
			return s
		}
	}
	return ""
}

func randomToken(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// 简单的 ReaderAt 包装
type byteReaderAt struct{ b []byte }

func (r *byteReaderAt) ReadAt(p []byte, off int64) (int, error) {
	if off >= int64(len(r.b)) {
		return 0, errors.New("EOF")
	}
	n := copy(p, r.b[off:])
	if n < len(p) {
		return n, errors.New("short read")
	}
	return n, nil
}

func bytesReaderAt(b []byte) *byteReaderAt { return &byteReaderAt{b: b} }
