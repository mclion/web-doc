package handler

import (
	"errors"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/xiaofengguo/web-doc/api/internal/auth"
	"github.com/xiaofengguo/web-doc/api/internal/model"
	"gorm.io/gorm"
)

// ============== 用户列表 ==============

func (h *Handler) AdminListUsers(c *gin.Context) {
	var users []model.User
	if err := h.DB.Order("created_at asc").Find(&users).Error; err != nil {
		serverError(c, err)
		return
	}
	out := make([]publicUserView, 0, len(users))
	for i := range users {
		out = append(out, publicUser(&users[i]))
	}
	c.JSON(http.StatusOK, gin.H{"items": out})
}

// ============== 创建用户（管理员，跳过注册开关） ==============

type adminCreateUserReq struct {
	Username    string `json:"username"`
	Password    string `json:"password"`
	Email       string `json:"email"`
	DisplayName string `json:"displayName"`
	Role        string `json:"role"`
}

func (h *Handler) AdminCreateUser(c *gin.Context) {
	var req adminCreateUserReq
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
	if req.Role != "admin" {
		req.Role = "user"
	}

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
	u := model.User{
		ID:           uuid.NewString(),
		Username:     req.Username,
		Email:        req.Email,
		PasswordHash: hash,
		DisplayName:  req.DisplayName,
		Role:         req.Role,
	}
	if err := h.DB.Create(&u).Error; err != nil {
		serverError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"user": publicUser(&u)})
}

// ============== 编辑用户 ==============

type adminUpdateUserReq struct {
	Role        *string `json:"role"`
	DisplayName *string `json:"displayName"`
	Email       *string `json:"email"`
	Password    *string `json:"password"`
}

func (h *Handler) AdminUpdateUser(c *gin.Context) {
	id := c.Param("id")
	var u model.User
	if err := h.DB.First(&u, "id = ?", id).Error; err != nil {
		notFound(c)
		return
	}
	var req adminUpdateUserReq
	if err := c.ShouldBindJSON(&req); err != nil {
		badRequest(c, err.Error())
		return
	}
	actingID := getLocal(c, "userID")

	if req.Role != nil && *req.Role != u.Role {
		if *req.Role != "admin" && *req.Role != "user" {
			badRequest(c, "role must be admin or user")
			return
		}
		if u.ID == actingID {
			badRequest(c, "不能修改自己的角色，请让另一位管理员操作")
			return
		}
		if u.Role == "admin" && *req.Role == "user" {
			if err := h.assertNotLastAdmin(c, u.ID); err != nil {
				return
			}
		}
		u.Role = *req.Role
	}
	if req.DisplayName != nil {
		u.DisplayName = strings.TrimSpace(*req.DisplayName)
	}
	if req.Email != nil {
		email := strings.TrimSpace(*req.Email)
		if email != "" {
			if !emailRe.MatchString(email) {
				badRequest(c, "邮箱格式不正确")
				return
			}
			var exist model.User
			if err := h.DB.Where("email = ? AND id <> ?", email, u.ID).First(&exist).Error; err == nil {
				c.AbortWithStatusJSON(http.StatusConflict, gin.H{"error": "邮箱已注册"})
				return
			} else if !errors.Is(err, gorm.ErrRecordNotFound) {
				serverError(c, err)
				return
			}
		}
		u.Email = email
	}
	if req.Password != nil && *req.Password != "" {
		if len(*req.Password) < 6 {
			badRequest(c, "密码至少 6 位")
			return
		}
		hash, err := auth.HashPassword(*req.Password)
		if err != nil {
			serverError(c, err)
			return
		}
		u.PasswordHash = hash
	}
	if err := h.DB.Save(&u).Error; err != nil {
		serverError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"user": publicUser(&u)})
}

// ============== 删除用户（级联删除其文档/存储/MCP Token） ==============

func (h *Handler) AdminDeleteUser(c *gin.Context) {
	id := c.Param("id")
	actingID := getLocal(c, "userID")
	if id == actingID {
		badRequest(c, "不能删除自己的账号")
		return
	}
	var u model.User
	if err := h.DB.First(&u, "id = ?", id).Error; err != nil {
		notFound(c)
		return
	}
	if u.Role == "admin" {
		if err := h.assertNotLastAdmin(c, u.ID); err != nil {
			return
		}
	}

	var roots []model.Node
	if err := h.DB.Where("owner_id = ? AND parent_id IS NULL", id).Find(&roots).Error; err != nil {
		serverError(c, err)
		return
	}
	for _, n := range roots {
		if err := h.deleteNodeTree(n); err != nil {
			serverError(c, err)
			return
		}
		if err := h.DB.Delete(&n).Error; err != nil {
			serverError(c, err)
			return
		}
	}
	if err := h.DB.Where("owner_id = ?", id).Delete(&model.MCPToken{}).Error; err != nil {
		serverError(c, err)
		return
	}
	if err := h.DB.Delete(&u).Error; err != nil {
		serverError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// assertNotLastAdmin 若 excludeID 是当前仅存的管理员，则写入 400 响应并返回非 nil error。
func (h *Handler) assertNotLastAdmin(c *gin.Context, excludeID string) error {
	var count int64
	if err := h.DB.Model(&model.User{}).Where("role = ? AND id <> ?", "admin", excludeID).Count(&count).Error; err != nil {
		serverError(c, err)
		return err
	}
	if count == 0 {
		err := errors.New("at least one admin required")
		badRequest(c, "至少保留一位管理员")
		return err
	}
	return nil
}
