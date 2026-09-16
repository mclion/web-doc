package db

import (
	"github.com/xiaofengguo/web-doc/api/internal/model"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

// Open 使用 PostgreSQL 打开数据库连接，并自动迁移所需表结构。
// dsn 例如：
//   host=localhost user=webdoc password=webdoc dbname=webdoc port=5432 sslmode=disable TimeZone=UTC
// 或 URL 风格：
//   postgres://webdoc:webdoc@localhost:5432/webdoc?sslmode=disable
func Open(dsn string) (*gorm.DB, error) {
	d, err := gorm.Open(postgres.Open(dsn), &gorm.Config{
		Logger: logger.Default.LogMode(logger.Warn),
	})
	if err != nil {
		return nil, err
	}
	if err := Migrate(d); err != nil {
		return nil, err
	}
	return d, nil
}

// Migrate 建表/迁移 + 兜底数据初始化。独立导出以便测试用其它 driver（如内存 sqlite）复用同一套表结构。
func Migrate(d *gorm.DB) error {
	// 历史遗留：users.email 曾是 uniqueIndex，多个用户都不填邮箱时会撞上 "" = "" 唯一约束。
	// 现在只在应用层校验非空邮箱唯一性（见 handler），这里把旧的唯一索引降级为普通索引。
	// AutoMigrate 不会自动放宽已存在的约束，所以显式 drop 一次；不存在则是 no-op，可安全重复执行。
	if err := d.Exec("DROP INDEX IF EXISTS idx_users_email").Error; err != nil {
		return err
	}
	if err := d.AutoMigrate(
		&model.Node{},
		&model.Share{},
		&model.AISettings{},
		&model.PromptTemplate{},
		&model.MCPToken{},
		&model.User{},
	); err != nil {
		return err
	}
	// 兜底：内置 Prompt 模板（仅首次插入）
	model.SeedBuiltinPrompts(d)
	// 兜底：给迁移前遗留的、没有 owner 的节点/Token 指派给最早注册的管理员
	// （全新部署下没有遗留数据，这里是 no-op）。
	backfillOwnership(d)
	return nil
}

// backfillOwnership 将 owner_id 为空的历史 Node/MCPToken 归属给最早创建的管理员账号（若存在）。
func backfillOwnership(d *gorm.DB) {
	var admin model.User
	if err := d.Where("role = ?", "admin").Order("created_at asc").First(&admin).Error; err != nil {
		return // 还没有任何管理员，等首个用户注册后人工处理
	}
	d.Model(&model.Node{}).Where("owner_id = ? OR owner_id IS NULL", "").Update("owner_id", admin.ID)
	d.Model(&model.MCPToken{}).Where("owner_id = ? OR owner_id IS NULL", "").Update("owner_id", admin.ID)
}
