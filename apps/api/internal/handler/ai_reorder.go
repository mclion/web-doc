package handler

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/xiaofengguo/web-doc/api/internal/ai"
	"github.com/xiaofengguo/web-doc/api/internal/model"
)

// ===================== AI 设置 =====================

func (h *Handler) GetAISettings(c *gin.Context) {
	s := h.loadOrInitSettings()
	masked := s
	if masked.APIKey != "" {
		masked.APIKey = maskKey(masked.APIKey)
	}
	configured := s.APIKey != "" && s.BaseURL != "" && s.Model != ""
	c.JSON(http.StatusOK, gin.H{"settings": masked, "configured": configured})
}

func (h *Handler) loadOrInitSettings() model.AISettings {
	var s model.AISettings
	if err := h.DB.First(&s, "id = ?", 1).Error; err != nil {
		s = model.AISettings{
			ID:                 1,
			Provider:           "openai",
			BaseURL:            "https://api.openai.com/v1",
			Model:              "gpt-4o-mini",
			SystemPrompt:       ai.DefaultSystemPrompt,
			SystemPromptCreate: ai.DefaultCreatePrompt,
			SystemPromptEdit:   ai.DefaultEditPrompt,
			Temperature:        0.7,
			MaxTokens:          8192,
			MaxToolRounds:      8,
		}
	}
	// 兼容旧版本：未设置时回落
	if s.SystemPromptCreate == "" {
		if s.SystemPrompt != "" {
			s.SystemPromptCreate = s.SystemPrompt
		} else {
			s.SystemPromptCreate = ai.DefaultCreatePrompt
		}
	}
	if s.SystemPromptEdit == "" {
		s.SystemPromptEdit = ai.DefaultEditPrompt
	}
	if s.MaxToolRounds <= 0 {
		s.MaxToolRounds = 8
	}
	return s
}

type updateAIReq struct {
	Provider           *string  `json:"provider"`
	BaseURL            *string  `json:"baseUrl"`
	APIKey             *string  `json:"apiKey"` // 空字符串表示不修改
	Model              *string  `json:"model"`
	SystemPrompt       *string  `json:"systemPrompt"`
	SystemPromptCreate *string  `json:"systemPromptCreate"`
	SystemPromptEdit   *string  `json:"systemPromptEdit"`
	EnableTools        *bool    `json:"enableTools"`
	MaxToolRounds      *int     `json:"maxToolRounds"`
	Temperature        *float64 `json:"temperature"`
	MaxTokens          *int     `json:"maxTokens"`
}

func (h *Handler) UpdateAISettings(c *gin.Context) {
	var req updateAIReq
	if err := c.ShouldBindJSON(&req); err != nil {
		badRequest(c, err.Error())
		return
	}
	var s model.AISettings
	if err := h.DB.First(&s, "id = ?", 1).Error; err != nil {
		s = model.AISettings{ID: 1}
	}
	if req.Provider != nil {
		s.Provider = *req.Provider
	}
	if req.BaseURL != nil {
		s.BaseURL = strings.TrimSpace(*req.BaseURL)
	}
	if req.APIKey != nil && *req.APIKey != "" && !strings.Contains(*req.APIKey, "•") {
		s.APIKey = *req.APIKey
	}
	if req.Model != nil {
		s.Model = *req.Model
	}
	if req.SystemPrompt != nil {
		s.SystemPrompt = *req.SystemPrompt
	}
	if req.SystemPromptCreate != nil {
		s.SystemPromptCreate = *req.SystemPromptCreate
	}
	if req.SystemPromptEdit != nil {
		s.SystemPromptEdit = *req.SystemPromptEdit
	}
	if req.EnableTools != nil {
		v := *req.EnableTools
		s.EnableTools = &v
	}
	if req.MaxToolRounds != nil {
		s.MaxToolRounds = *req.MaxToolRounds
	}
	if req.Temperature != nil {
		s.Temperature = *req.Temperature
	}
	if req.MaxTokens != nil {
		s.MaxTokens = *req.MaxTokens
	}
	s.UpdatedAt = time.Now()
	if err := h.DB.Save(&s).Error; err != nil {
		serverError(c, err)
		return
	}
	masked := s
	if masked.APIKey != "" {
		masked.APIKey = maskKey(masked.APIKey)
	}
	c.JSON(http.StatusOK, masked)
}

func maskKey(k string) string {
	if len(k) <= 8 {
		return strings.Repeat("•", len(k))
	}
	return k[:4] + strings.Repeat("•", 6) + k[len(k)-4:]
}

// ===================== Prompt 模板管理 =====================

func (h *Handler) ListPrompts(c *gin.Context) {
	scene := c.Query("scene") // 可选过滤
	q := h.DB.Model(&model.PromptTemplate{}).Order("builtin desc, is_default desc, updated_at desc")
	if scene != "" {
		q = q.Where("scene = ?", scene)
	}
	var list []model.PromptTemplate
	if err := q.Find(&list).Error; err != nil {
		serverError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"items": list})
}

type promptUpsertReq struct {
	Name      string `json:"name"`
	Scene     string `json:"scene"` // create | edit
	Content   string `json:"content"`
	IsDefault bool   `json:"isDefault"`
}

func (h *Handler) CreatePrompt(c *gin.Context) {
	var req promptUpsertReq
	if err := c.ShouldBindJSON(&req); err != nil {
		badRequest(c, err.Error())
		return
	}
	if strings.TrimSpace(req.Name) == "" || strings.TrimSpace(req.Content) == "" {
		badRequest(c, "name and content required")
		return
	}
	if req.Scene != "create" && req.Scene != "edit" {
		req.Scene = "create"
	}
	p := model.PromptTemplate{
		ID:        model.NewPromptID(),
		Name:      req.Name,
		Scene:     req.Scene,
		Content:   req.Content,
		Builtin:   false,
		IsDefault: req.IsDefault,
		CreatedAt: time.Now(),
		UpdatedAt: time.Now(),
	}
	if req.IsDefault {
		// 把同 scene 其他默认置为 false
		h.DB.Model(&model.PromptTemplate{}).Where("scene = ?", req.Scene).Update("is_default", false)
	}
	if err := h.DB.Create(&p).Error; err != nil {
		serverError(c, err)
		return
	}
	c.JSON(http.StatusOK, p)
}

func (h *Handler) UpdatePrompt(c *gin.Context) {
	id := c.Param("id")
	var p model.PromptTemplate
	if err := h.DB.First(&p, "id = ?", id).Error; err != nil {
		notFound(c)
		return
	}
	var req promptUpsertReq
	if err := c.ShouldBindJSON(&req); err != nil {
		badRequest(c, err.Error())
		return
	}
	// 内置项不允许改 scene；可改名/内容/默认
	if req.Name != "" {
		p.Name = req.Name
	}
	if !p.Builtin && req.Scene != "" && (req.Scene == "create" || req.Scene == "edit") {
		p.Scene = req.Scene
	}
	if req.Content != "" {
		p.Content = req.Content
	}
	if req.IsDefault {
		h.DB.Model(&model.PromptTemplate{}).Where("scene = ? AND id <> ?", p.Scene, p.ID).Update("is_default", false)
		p.IsDefault = true
	} else {
		p.IsDefault = false
	}
	p.UpdatedAt = time.Now()
	if err := h.DB.Save(&p).Error; err != nil {
		serverError(c, err)
		return
	}
	c.JSON(http.StatusOK, p)
}

func (h *Handler) DeletePrompt(c *gin.Context) {
	id := c.Param("id")
	var p model.PromptTemplate
	if err := h.DB.First(&p, "id = ?", id).Error; err != nil {
		notFound(c)
		return
	}
	if p.Builtin {
		badRequest(c, "builtin prompt cannot be deleted")
		return
	}
	if err := h.DB.Delete(&p).Error; err != nil {
		serverError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// ===================== AI 生成（SSE 流式 + Tool Calling Agent Loop） =====================

type aiGenerateReq struct {
	Prompt   string  `json:"prompt"`
	DocID    string  `json:"docId"`    // 复用已有文档（重写/迭代）
	ParentID *string `json:"parentId"` // 新建到指定文件夹
	Title    string  `json:"title"`    // 新建文档标题
	Mode     string  `json:"mode"`     // create | rewrite | edit
	PromptID string  `json:"promptId"` // 可选：使用指定 PromptTemplate
	UseTools *bool   `json:"useTools"` // 可选：覆盖全局 enableTools 设置
}

// AIGenerate SSE 事件类型：
//   - meta:        {docId, mode, title}
//   - delta:       {text}                 普通文本（创建模式的 HTML 流；或 edit 模式的模型解释文本）
//   - tool_call:   {id, name, args}       Agent 调用工具
//   - tool_result: {id, name, ok, summary, error}
//   - round:       {round, finishReason}  本轮 LLM 响应结束
//   - done:        {docId, bytes}
//   - error:       {message}
func (h *Handler) AIGenerate(c *gin.Context) {
	var req aiGenerateReq
	if err := c.ShouldBindJSON(&req); err != nil {
		badRequest(c, err.Error())
		return
	}
	req.Prompt = strings.TrimSpace(req.Prompt)
	if req.Prompt == "" {
		badRequest(c, "prompt is required")
		return
	}

	s := h.loadOrInitSettings()
	if s.APIKey == "" || s.BaseURL == "" || s.Model == "" {
		c.AbortWithStatusJSON(http.StatusBadRequest, gin.H{"error": "AI 未配置，请先在设置中填写 BaseURL / APIKey / Model"})
		return
	}

	// 选取系统 Prompt：优先 PromptID > 模式默认 prompt
	var systemPrompt string
	if req.PromptID != "" {
		var p model.PromptTemplate
		if err := h.DB.First(&p, "id = ?", req.PromptID).Error; err == nil {
			systemPrompt = p.Content
		}
	}
	if systemPrompt == "" {
		switch req.Mode {
		case "edit":
			systemPrompt = s.SystemPromptEdit
		default:
			systemPrompt = s.SystemPromptCreate
		}
	}

	// 准备目标文档：
	// - 若前端传了 docId 且能查到 → 复用该文档（无论 mode）。这样在“AI 新文档”里发起的 create
	//   首轮调用，也会写到当前文档，而不是又新建一个文档导致看不到结果。
	// - 否则按 mode 处理：rewrite/edit 必须传 docId；create 才允许新建。
	uid := getLocal(c, "userID")
	var target model.Node
	if req.DocID != "" {
		if err := h.DB.First(&target, "id = ? AND type = 'doc'", req.DocID).Error; err != nil || target.OwnerID != uid {
			notFound(c)
			return
		}
	} else if req.Mode == "rewrite" || req.Mode == "edit" {
		badRequest(c, "docId required for rewrite/edit mode")
		return
	} else {
		if req.ParentID != nil && *req.ParentID != "" {
			var parent model.Node
			if err := h.DB.Select("id", "owner_id").First(&parent, "id = ?", *req.ParentID).Error; err != nil || parent.OwnerID != uid {
				notFound(c)
				return
			}
		}
		title := req.Title
		if title == "" {
			title = "AI · " + truncateRune(req.Prompt, 16)
		}
		target = model.Node{
			ID:         uuid.NewString(),
			OwnerID:    uid,
			ParentID:   req.ParentID,
			Type:       "doc",
			Title:      title,
			EntryFile:  "index.html",
			Visibility: "private",
		}
		if err := h.Storage.CreateDoc(target.ID, "<!doctype html><html><body><p>Generating…</p></body></html>"); err != nil {
			serverError(c, err)
			return
		}
		h.Hub.AddDocWatch(h.Storage.DocPath(target.ID))
		if err := h.DB.Create(&target).Error; err != nil {
			serverError(c, err)
			return
		}
	}

	// 是否启用 tools：edit 模式默认开；create 模式默认关
	useTools := req.Mode == "edit"
	if s.EnableTools != nil {
		useTools = useTools && *s.EnableTools
	}
	if req.UseTools != nil {
		useTools = *req.UseTools
	}

	// 构造首轮 messages
	messages := []ai.ChatMessage{{Role: "system", Content: systemPrompt}}

	if useTools {
		// edit 模式：不直接把全文塞给模型，只给文件清单（让模型主动 read_file）
		files, _ := h.Storage.ListFiles(target.ID)
		ctxNote := buildEditContextHint(&target, files)
		messages = append(messages, ai.ChatMessage{Role: "user", Content: ctxNote + "\n\n用户需求：\n" + req.Prompt})
	} else if req.Mode == "edit" {
		// 旧路径：把全文一起发
		full, _ := h.Storage.ResolveSafe(target.ID, target.EntryFile)
		var existing string
		if data, err := os.ReadFile(full); err == nil {
			existing = string(data)
		}
		userContent := "请基于以下现有 HTML 文档进行修改，只输出最终完整 HTML：\n\n" +
			"现有文档：\n```html\n" + existing + "\n```\n\n修改要求：\n" + req.Prompt
		messages = append(messages, ai.ChatMessage{Role: "user", Content: userContent})
	} else {
		messages = append(messages, ai.ChatMessage{Role: "user", Content: req.Prompt})
	}

	settings := ai.Settings{
		BaseURL:      s.BaseURL,
		APIKey:       s.APIKey,
		Model:        s.Model,
		SystemPrompt: systemPrompt,
		Temperature:  s.Temperature,
		MaxTokens:    s.MaxTokens,
	}
	maxRounds := s.MaxToolRounds
	if maxRounds <= 0 {
		maxRounds = 8
	}

	// 设置 SSE 响应头
	c.Header("Content-Type", "text/event-stream")
	c.Header("Cache-Control", "no-cache")
	c.Header("Connection", "keep-alive")
	c.Header("X-Accel-Buffering", "no")
	c.Status(http.StatusOK)

	flusher, ok := c.Writer.(http.Flusher)
	if !ok {
		serverError(c, errors.New("streaming unsupported"))
		return
	}

	// bufio.Writer 包一层，便于和原本的代码风格对齐；但每次 flush 都直接调底层 flusher
	bw := bufio.NewWriter(c.Writer)
	var writeMu sync.Mutex
	writeEvent := func(event string, data any) {
		writeMu.Lock()
		defer writeMu.Unlock()
		b, _ := json.Marshal(data)
		fmt.Fprintf(bw, "event: %s\ndata: %s\n\n", event, string(b))
		_ = bw.Flush()
		flusher.Flush()
	}

	writeEvent("meta", gin.H{"docId": target.ID, "mode": req.Mode, "title": target.Title, "useTools": useTools})

	ctx, cancel := context.WithTimeout(c.Request.Context(), 15*time.Minute)
	defer cancel()

	if useTools {
		h.runAgentLoop(ctx, settings, &messages, &target, maxRounds, writeEvent)
	} else {
		h.runDirectGenerate(ctx, settings, messages, &target, writeEvent)
	}

	// 更新 size
	target.SizeBytes = h.Storage.DocSize(target.ID)
	h.DB.Save(&target)

	writeEvent("done", gin.H{"docId": target.ID, "bytes": target.SizeBytes})
}

// runDirectGenerate 旧 create / 整文档重写流程（直接落盘 HTML 文本）
func (h *Handler) runDirectGenerate(
	ctx context.Context,
	settings ai.Settings,
	messages []ai.ChatMessage,
	target *model.Node,
	writeEvent func(string, any),
) {
	var (
		mu        sync.Mutex
		buf       strings.Builder
		lastFlush = time.Now()
	)
	flushToDisk := func(force bool) {
		mu.Lock()
		defer mu.Unlock()
		if buf.Len() == 0 {
			return
		}
		if !force && time.Since(lastFlush) < 300*time.Millisecond {
			return
		}
		lastFlush = time.Now()
		html := ai.ExtractHTML(buf.String())
		html = ai.EnsureFullHTML(html)
		full, err := h.Storage.ResolveSafe(target.ID, target.EntryFile)
		if err == nil {
			_ = os.MkdirAll(filepath.Dir(full), 0o755)
			_ = os.WriteFile(full, []byte(html), 0o644)
		}
	}

	_, err := ai.StreamChat(ctx, settings, messages, nil, ai.StreamCallbacks{
		OnContentDelta: func(delta string) {
			mu.Lock()
			buf.WriteString(delta)
			mu.Unlock()
			writeEvent("delta", gin.H{"text": delta})
			flushToDisk(false)
		},
	})
	if err != nil {
		writeEvent("error", gin.H{"message": err.Error()})
		return
	}
	flushToDisk(true)
}

// runAgentLoop tool calling 循环
func (h *Handler) runAgentLoop(
	ctx context.Context,
	settings ai.Settings,
	messages *[]ai.ChatMessage,
	target *model.Node,
	maxRounds int,
	writeEvent func(string, any),
) {
	tools := ai.BuildToolset()

	for round := 1; round <= maxRounds; round++ {
		select {
		case <-ctx.Done():
			writeEvent("error", gin.H{"message": "timeout"})
			return
		default:
		}

		result, err := ai.StreamChat(ctx, settings, *messages, tools, ai.StreamCallbacks{
			OnContentDelta: func(delta string) {
				writeEvent("delta", gin.H{"text": delta})
			},
			OnToolCallStart: func(index int, id, name string) {
				writeEvent("tool_call_start", gin.H{"index": index, "id": id, "name": name})
			},
			OnToolCallArgs: func(index int, deltaArgs string) {
				writeEvent("tool_call_args", gin.H{"index": index, "delta": deltaArgs})
			},
		})
		if err != nil {
			writeEvent("error", gin.H{"message": err.Error()})
			return
		}

		// 把 assistant 消息（含 tool_calls）追加到对话上下文
		assistantMsg := ai.ChatMessage{
			Role:      "assistant",
			Content:   result.Content,
			ToolCalls: result.ToolCalls,
		}
		*messages = append(*messages, assistantMsg)

		writeEvent("round", gin.H{"round": round, "finishReason": result.FinishReason, "toolCalls": len(result.ToolCalls)})

		// 没有 tool calls：本轮结束
		if len(result.ToolCalls) == 0 {
			return
		}

		// 执行所有 tool calls
		for _, tc := range result.ToolCalls {
			toolResult, summary, runErr := h.executeTool(target, tc)
			ok := runErr == nil
			respContent := toolResult
			errStr := ""
			if runErr != nil {
				errStr = runErr.Error()
				respContent = "ERROR: " + runErr.Error()
			}
			writeEvent("tool_result", gin.H{
				"id":      tc.ID,
				"name":    tc.Function.Name,
				"ok":      ok,
				"summary": summary,
				"error":   errStr,
			})

			// 把 tool 结果回到 messages
			*messages = append(*messages, ai.ChatMessage{
				Role:       "tool",
				ToolCallID: tc.ID,
				Name:       tc.Function.Name,
				Content:    respContent,
			})
		}
	}
	writeEvent("error", gin.H{"message": fmt.Sprintf("超过最大工具调用轮次 %d", maxRounds)})
}

// executeTool 在文档目录下执行工具
// 返回 (raw 内容回传给模型, 友好的 summary 给前端展示, error)
func (h *Handler) executeTool(target *model.Node, tc ai.ToolCall) (string, string, error) {
	name := tc.Function.Name
	rawArgs := strings.TrimSpace(tc.Function.Arguments)
	if rawArgs == "" {
		rawArgs = "{}"
	}

	switch name {
	case "list_files":
		files, err := h.Storage.ListFiles(target.ID)
		if err != nil {
			return "", "list_files 失败", err
		}
		out, _ := json.Marshal(map[string]any{"files": files})
		return string(out), fmt.Sprintf("列出 %d 个文件", len(files)), nil

	case "read_file":
		var args struct {
			Path string `json:"path"`
		}
		if err := json.Unmarshal([]byte(rawArgs), &args); err != nil {
			return "", "参数解析失败", err
		}
		if args.Path == "" {
			return "", "缺少 path", errors.New("missing path")
		}
		full, err := h.Storage.ResolveSafe(target.ID, args.Path)
		if err != nil {
			return "", "非法路径", err
		}
		data, err := os.ReadFile(full)
		if err != nil {
			return "", fmt.Sprintf("read_file %s 失败", args.Path), err
		}
		// 截断保护，避免单次回灌过大的内容
		const maxRead = 200_000
		content := string(data)
		truncated := false
		if len(content) > maxRead {
			content = content[:maxRead]
			truncated = true
		}
		out, _ := json.Marshal(map[string]any{
			"path":      args.Path,
			"content":   content,
			"bytes":     len(data),
			"truncated": truncated,
		})
		return string(out), fmt.Sprintf("读取 %s（%d bytes）", args.Path, len(data)), nil

	case "write_file":
		var args struct {
			Path    string `json:"path"`
			Content string `json:"content"`
		}
		if err := json.Unmarshal([]byte(rawArgs), &args); err != nil {
			return "", "参数解析失败", err
		}
		if args.Path == "" {
			return "", "缺少 path", errors.New("missing path")
		}
		if err := h.Storage.WriteFile(target.ID, args.Path, []byte(args.Content)); err != nil {
			return "", fmt.Sprintf("write_file %s 失败", args.Path), err
		}
		out, _ := json.Marshal(map[string]any{"ok": true, "path": args.Path, "bytes": len(args.Content)})
		return string(out), fmt.Sprintf("写入 %s（%d bytes）", args.Path, len(args.Content)), nil

	case "replace_in_file":
		var args struct {
			Path      string `json:"path"`
			OldString string `json:"old_string"`
			NewString string `json:"new_string"`
		}
		if err := json.Unmarshal([]byte(rawArgs), &args); err != nil {
			return "", "参数解析失败", err
		}
		if args.Path == "" || args.OldString == "" {
			return "", "path 与 old_string 必填", errors.New("missing path/old_string")
		}
		full, err := h.Storage.ResolveSafe(target.ID, args.Path)
		if err != nil {
			return "", "非法路径", err
		}
		raw, err := os.ReadFile(full)
		if err != nil {
			return "", fmt.Sprintf("读取 %s 失败", args.Path), err
		}
		content := string(raw)
		count := strings.Count(content, args.OldString)
		if count == 0 {
			return "", fmt.Sprintf("%s 中未找到 old_string", args.Path),
				errors.New("old_string 在文件中未找到，请先用 read_file 读取最新内容；注意不要转义换行/制表符")
		}
		if count > 1 {
			return "", fmt.Sprintf("%s 中匹配到 %d 处，需更精确", args.Path, count),
				fmt.Errorf("old_string 不唯一（%d 处匹配），请扩大上下文确保唯一定位", count)
		}
		newContent := strings.Replace(content, args.OldString, args.NewString, 1)
		if err := h.Storage.WriteFile(target.ID, args.Path, []byte(newContent)); err != nil {
			return "", fmt.Sprintf("写回 %s 失败", args.Path), err
		}
		out, _ := json.Marshal(map[string]any{
			"ok": true, "path": args.Path,
			"replaced": 1, "bytes": len(newContent),
		})
		return string(out), fmt.Sprintf("替换 %s 中 1 处（%d→%d bytes）", args.Path, len(content), len(newContent)), nil
	}
	return "", "未知工具", fmt.Errorf("unknown tool: %s", name)
}

// buildEditContextHint edit 模式注入的上下文说明
func buildEditContextHint(n *model.Node, files []string) string {
	var b strings.Builder
	b.WriteString("# 当前文档信息\n")
	b.WriteString("- 标题：" + n.Title + "\n")
	b.WriteString("- 入口文件：" + n.EntryFile + "\n")
	b.WriteString("- 文件列表：\n")
	for _, f := range files {
		b.WriteString("  - " + f + "\n")
	}
	b.WriteString("\n你可以使用工具读取并修改这些文件。请先 list_files / read_file 了解情况，再决定如何修改。")
	return b.String()
}

// ===================== 节点重排序 / 移动 =====================

type reorderItem struct {
	ID        string  `json:"id"`
	ParentID  *string `json:"parentId"` // null 或 "" 表示根
	SortOrder int     `json:"sortOrder"`
}

func (h *Handler) ReorderNodes(c *gin.Context) {
	var req struct {
		Items []reorderItem `json:"items"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		badRequest(c, err.Error())
		return
	}
	uid := getLocal(c, "userID")
	tx := h.DB.Begin()
	for _, it := range req.Items {
		var owned model.Node
		if err := tx.Select("id", "owner_id").First(&owned, "id = ?", it.ID).Error; err != nil || owned.OwnerID != uid {
			tx.Rollback()
			notFound(c)
			return
		}
		var parentID *string
		if it.ParentID != nil && *it.ParentID != "" {
			pid := *it.ParentID
			parentID = &pid
		}
		if parentID != nil {
			var parent model.Node
			if err := tx.Select("id", "owner_id").First(&parent, "id = ?", *parentID).Error; err != nil || parent.OwnerID != uid {
				tx.Rollback()
				notFound(c)
				return
			}
		}
		if parentID != nil && (*parentID == it.ID || h.isDescendant(it.ID, *parentID)) {
			tx.Rollback()
			badRequest(c, "cannot move into self or descendant")
			return
		}
		if err := tx.Model(&model.Node{}).Where("id = ?", it.ID).
			Updates(map[string]any{"parent_id": parentID, "sort_order": it.SortOrder}).Error; err != nil {
			tx.Rollback()
			serverError(c, err)
			return
		}
	}
	if err := tx.Commit().Error; err != nil {
		serverError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func (h *Handler) isDescendant(ancestor, candidate string) bool {
	current := candidate
	for i := 0; i < 100; i++ {
		var n model.Node
		if err := h.DB.Select("parent_id").First(&n, "id = ?", current).Error; err != nil {
			return false
		}
		if n.ParentID == nil {
			return false
		}
		if *n.ParentID == ancestor {
			return true
		}
		current = *n.ParentID
	}
	return false
}

// ===================== 文件保存（编辑器） =====================

type saveFileReq struct {
	Path    string `json:"path"`
	Content string `json:"content"`
}

func (h *Handler) SaveFile(c *gin.Context) {
	id := c.Param("id")
	n, ok := h.loadOwnedNode(c, id, true)
	if !ok {
		return
	}
	var req saveFileReq
	if err := c.ShouldBindJSON(&req); err != nil {
		badRequest(c, err.Error())
		return
	}
	if req.Path == "" {
		req.Path = "index.html"
	}
	if err := h.Storage.WriteFile(id, req.Path, []byte(req.Content)); err != nil {
		badRequest(c, err.Error())
		return
	}
	n.SizeBytes = h.Storage.DocSize(id)
	h.DB.Save(&n)
	c.JSON(http.StatusOK, gin.H{"ok": true, "path": req.Path, "size": n.SizeBytes})
}

func truncateRune(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n]) + "…"
}
