package model

import (
	"time"

	"gorm.io/gorm"
)

// NodeType: "folder" or "doc"
type Node struct {
	ID         string         `gorm:"primaryKey;size:36" json:"id"`
	OwnerID    string         `gorm:"size:36;index" json:"ownerId,omitempty"`
	ParentID   *string        `gorm:"index;size:36" json:"parentId,omitempty"`
	Type       string         `gorm:"size:16;index" json:"type"` // folder | doc
	Title      string         `gorm:"size:255" json:"title"`
	EntryFile  string         `gorm:"size:255;default:'index.html'" json:"entryFile,omitempty"`
	SortOrder  int            `gorm:"default:0" json:"sortOrder"`
	Visibility string         `gorm:"size:16;default:'private'" json:"visibility"` // private | public
	SizeBytes  int64          `json:"sizeBytes"`
	CreatedAt  time.Time      `json:"createdAt"`
	UpdatedAt  time.Time      `json:"updatedAt"`
	DeletedAt  gorm.DeletedAt `gorm:"index" json:"-"`
}

type Share struct {
	ID         string    `gorm:"primaryKey;size:36" json:"id"`
	DocID      string    `gorm:"size:36;index" json:"docId"`
	Token      string    `gorm:"size:32;uniqueIndex" json:"token"`
	ExpiresAt  *time.Time `json:"expiresAt,omitempty"`
	CreatedAt  time.Time `json:"createdAt"`
}

// AISettings 全局唯一配置（单行）
type AISettings struct {
	ID                 uint      `gorm:"primaryKey" json:"id"`
	Provider           string    `gorm:"size:32;default:'openai'" json:"provider"` // openai | anthropic（保留）
	BaseURL            string    `gorm:"size:255" json:"baseUrl"`
	APIKey             string    `gorm:"size:255" json:"apiKey"`
	Model              string    `gorm:"size:128" json:"model"`
	// SystemPrompt 保留作为兼容字段（旧版本调用为 create+edit 公用）
	SystemPrompt       string    `gorm:"type:text" json:"systemPrompt"`
	// SystemPromptCreate 创建新文档时使用的系统提示词
	SystemPromptCreate string    `gorm:"type:text" json:"systemPromptCreate"`
	// SystemPromptEdit 修改现有文档时（启用 tools）使用的系统提示词
	SystemPromptEdit   string    `gorm:"type:text" json:"systemPromptEdit"`
	// EnableTools edit 场景是否启用 tool calling（默认 true）
	EnableTools        *bool     `gorm:"default:true" json:"enableTools"`
	// MaxToolRounds Agent loop 最多调用轮次（默认 8）
	MaxToolRounds      int       `gorm:"default:8" json:"maxToolRounds"`
	Temperature        float64   `gorm:"default:0.7" json:"temperature"`
	MaxTokens          int       `gorm:"default:8192" json:"maxTokens"`
	UpdatedAt          time.Time `json:"updatedAt"`
}

// MCPToken 用于 MCP 接入鉴权（Bearer Token）
type MCPToken struct {
	ID         string     `gorm:"primaryKey;size:36" json:"id"`
	OwnerID    string     `gorm:"size:36;index" json:"ownerId,omitempty"`
	Name       string     `gorm:"size:128" json:"name"`
	Token      string     `gorm:"size:64;uniqueIndex" json:"token"`
	LastUsedAt *time.Time `json:"lastUsedAt,omitempty"`
	CreatedAt  time.Time  `json:"createdAt"`
}

// PromptTemplate 用户可管理的 Prompt 模板（预设 + 自定义）
type PromptTemplate struct {
	ID        string    `gorm:"primaryKey;size:36" json:"id"`
	Name      string    `gorm:"size:128" json:"name"`
	Scene     string    `gorm:"size:16;index" json:"scene"`   // create | edit | shared
	Content   string    `gorm:"type:text" json:"content"`
	Builtin   bool      `gorm:"default:false" json:"builtin"` // 内置：不可删除
	IsDefault bool      `gorm:"default:false" json:"isDefault"`
	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`
}

// User 注册账号
type User struct {
	ID           string         `gorm:"primaryKey;size:36" json:"id"`
	Username     string         `gorm:"size:64;uniqueIndex" json:"username"`
	// 邮箱可选；唯一性只在应用层对非空邮箱校验（见 AuthRegister/AdminCreateUser），
	// 所以这里不加数据库级 uniqueIndex——否则多个用户都不填邮箱时，第二个用户会因为
	// 两个空字符串 "" 撞上唯一约束而注册失败。
	Email        string         `gorm:"size:128;index" json:"email,omitempty"`
	PasswordHash string         `gorm:"size:128" json:"-"`
	DisplayName  string         `gorm:"size:128" json:"displayName,omitempty"`
	Role         string         `gorm:"size:16;default:'user'" json:"role"` // admin | user
	CreatedAt    time.Time      `json:"createdAt"`
	UpdatedAt    time.Time      `json:"updatedAt"`
	DeletedAt    gorm.DeletedAt `gorm:"index" json:"-"`
}
