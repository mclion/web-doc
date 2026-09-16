package router

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/glebarez/sqlite"
	"github.com/xiaofengguo/web-doc/api/internal/config"
	"github.com/xiaofengguo/web-doc/api/internal/db"
	"github.com/xiaofengguo/web-doc/api/internal/handler"
	"github.com/xiaofengguo/web-doc/api/internal/storage"
	"github.com/xiaofengguo/web-doc/api/internal/watcher"
	"gorm.io/gorm"
)

// ---------- test scaffolding ----------

func newTestApp(t *testing.T) *gin.Engine {
	t.Helper()
	// 每个测试用独立命名的内存库，避免 file::memory:?cache=shared 让所有测试共用同一份数据。
	dsn := fmt.Sprintf("file:%s?mode=memory&cache=shared", t.Name())
	gdb, err := gorm.Open(sqlite.Open(dsn), &gorm.Config{})
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	sqlDB, err := gdb.DB()
	if err != nil {
		t.Fatalf("sql.DB: %v", err)
	}
	// 内存 sqlite：每个连接是独立数据库，限制为单连接以共享同一份数据。
	sqlDB.SetMaxOpenConns(1)
	if err := db.Migrate(gdb); err != nil {
		t.Fatalf("migrate: %v", err)
	}

	st, err := storage.New(t.TempDir())
	if err != nil {
		t.Fatalf("storage.New: %v", err)
	}
	hub, err := watcher.NewHub(t.TempDir())
	if err != nil {
		t.Fatalf("watcher.NewHub: %v", err)
	}

	h := handler.New(gdb, st, hub)
	h.JWTSecret = "test-secret"

	cfg := &config.Config{MaxUploadMB: 50, AllowOrigin: "*"}
	return New(h, cfg)
}

func doReq(app *gin.Engine, method, path, token string, body any) *httptest.ResponseRecorder {
	var r *bytes.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		r = bytes.NewReader(b)
	} else {
		r = bytes.NewReader(nil)
	}
	req := httptest.NewRequest(method, path, r)
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	rw := httptest.NewRecorder()
	app.ServeHTTP(rw, req)
	return rw
}

type registeredUser struct {
	Token string
	ID    string
	Role  string
}

func registerUser(t *testing.T, app *gin.Engine, username string) registeredUser {
	t.Helper()
	rw := doReq(app, "POST", "/api/auth/register", "", map[string]string{
		"username": username,
		"password": "password123",
	})
	if rw.Code != http.StatusOK {
		t.Fatalf("register %s failed: %d %s", username, rw.Code, rw.Body.String())
	}
	var resp struct {
		User struct {
			ID   string `json:"id"`
			Role string `json:"role"`
		} `json:"user"`
		Token string `json:"token"`
	}
	if err := json.Unmarshal(rw.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode register response: %v", err)
	}
	return registeredUser{Token: resp.Token, ID: resp.User.ID, Role: resp.User.Role}
}

func createDoc(t *testing.T, app *gin.Engine, token, title string) string {
	t.Helper()
	rw := doReq(app, "POST", "/api/nodes", token, map[string]any{
		"type":  "doc",
		"title": title,
		"html":  "<html><body>hi</body></html>",
	})
	if rw.Code != http.StatusOK {
		t.Fatalf("create doc failed: %d %s", rw.Code, rw.Body.String())
	}
	var n struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(rw.Body.Bytes(), &n); err != nil {
		t.Fatalf("decode create doc response: %v", err)
	}
	return n.ID
}

// ---------- ownership: nodes ----------

func TestCreateNode_RequiresAuth(t *testing.T) {
	app := newTestApp(t)
	rw := doReq(app, "POST", "/api/nodes", "", map[string]any{"type": "doc", "title": "x"})
	if rw.Code != http.StatusUnauthorized {
		t.Fatalf("want 401, got %d %s", rw.Code, rw.Body.String())
	}
}

func TestListNodes_OwnerScoping(t *testing.T) {
	app := newTestApp(t)
	alice := registerUser(t, app, "alice")
	bob := registerUser(t, app, "bob")

	createDoc(t, app, alice.Token, "alice-doc")
	createDoc(t, app, bob.Token, "bob-doc")

	rw := doReq(app, "GET", "/api/nodes", alice.Token, nil)
	if rw.Code != http.StatusOK {
		t.Fatalf("list nodes: %d %s", rw.Code, rw.Body.String())
	}
	var out struct {
		Items []struct {
			Title string `json:"title"`
		} `json:"items"`
	}
	json.Unmarshal(rw.Body.Bytes(), &out)
	if len(out.Items) != 1 || out.Items[0].Title != "alice-doc" {
		t.Fatalf("alice should only see her own doc, got %+v", out.Items)
	}
}

func TestGetNode_ForbiddenForNonOwner(t *testing.T) {
	app := newTestApp(t)
	alice := registerUser(t, app, "alice")
	bob := registerUser(t, app, "bob")

	docID := createDoc(t, app, alice.Token, "alice-doc")

	rw := doReq(app, "GET", "/api/nodes/"+docID, bob.Token, nil)
	if rw.Code != http.StatusNotFound {
		t.Fatalf("bob should get 404 for alice's doc, got %d %s", rw.Code, rw.Body.String())
	}

	rw = doReq(app, "GET", "/api/nodes/"+docID, alice.Token, nil)
	if rw.Code != http.StatusOK {
		t.Fatalf("alice should be able to read her own doc, got %d %s", rw.Code, rw.Body.String())
	}
}

func TestReorderNodes_RejectsForeignParent(t *testing.T) {
	app := newTestApp(t)
	alice := registerUser(t, app, "alice")
	bob := registerUser(t, app, "bob")

	aliceDoc := createDoc(t, app, alice.Token, "alice-doc")
	bobFolderRW := doReq(app, "POST", "/api/nodes", bob.Token, map[string]any{"type": "folder", "title": "bob-folder"})
	var bobFolder struct {
		ID string `json:"id"`
	}
	json.Unmarshal(bobFolderRW.Body.Bytes(), &bobFolder)

	rw := doReq(app, "PATCH", "/api/nodes/reorder/batch", alice.Token, map[string]any{
		"items": []map[string]any{
			{"id": aliceDoc, "parentId": bobFolder.ID, "sortOrder": 0},
		},
	})
	if rw.Code != http.StatusNotFound {
		t.Fatalf("moving into another user's folder should 404, got %d %s", rw.Code, rw.Body.String())
	}
}

// ---------- share flow ----------

func TestShareFlow_PublicAfterShare(t *testing.T) {
	app := newTestApp(t)
	alice := registerUser(t, app, "alice")
	bob := registerUser(t, app, "bob")
	docID := createDoc(t, app, alice.Token, "alice-doc")

	// bob cannot mint a share for alice's doc
	rw := doReq(app, "POST", "/api/docs/"+docID+"/share", bob.Token, nil)
	if rw.Code != http.StatusNotFound {
		t.Fatalf("bob should not be able to share alice's doc, got %d %s", rw.Code, rw.Body.String())
	}

	// asset/metadata/file content are not reachable anonymously before sharing
	rw = doReq(app, "GET", "/d/"+docID+"/index.html", "", nil)
	if rw.Code != http.StatusNotFound {
		t.Fatalf("unshared doc asset should 404 anonymously, got %d", rw.Code)
	}
	rw = doReq(app, "GET", "/api/nodes/"+docID, "", nil)
	if rw.Code != http.StatusNotFound {
		t.Fatalf("unshared doc node should 404 anonymously, got %d", rw.Code)
	}

	// alice shares her own doc
	rw = doReq(app, "POST", "/api/docs/"+docID+"/share", alice.Token, nil)
	if rw.Code != http.StatusOK {
		t.Fatalf("alice share failed: %d %s", rw.Code, rw.Body.String())
	}
	var share struct {
		Token string `json:"token"`
	}
	json.Unmarshal(rw.Body.Bytes(), &share)
	if share.Token == "" {
		t.Fatalf("expected a share token")
	}

	// anonymous share-info lookup works
	rw = doReq(app, "GET", "/api/shares/"+share.Token, "", nil)
	if rw.Code != http.StatusOK {
		t.Fatalf("anonymous share info failed: %d %s", rw.Code, rw.Body.String())
	}

	// anonymous asset fetch now works because the doc became public
	rw = doReq(app, "GET", "/d/"+docID+"/index.html", "", nil)
	if rw.Code != http.StatusOK {
		t.Fatalf("shared doc asset should be public, got %d %s", rw.Code, rw.Body.String())
	}

	// regression: DocViewer also needs the node metadata + file content endpoints
	// to work anonymously once a doc is public (it fetches these to build the
	// file list / code view even in preview mode) — see the /s/:token flow.
	rw = doReq(app, "GET", "/api/nodes/"+docID, "", nil)
	if rw.Code != http.StatusOK {
		t.Fatalf("shared doc node metadata should be readable anonymously, got %d %s", rw.Code, rw.Body.String())
	}
	rw = doReq(app, "GET", "/api/docs/"+docID+"/file?path=index.html", "", nil)
	if rw.Code != http.StatusOK {
		t.Fatalf("shared doc file content should be readable anonymously, got %d %s", rw.Code, rw.Body.String())
	}
}

// ---------- admin ----------

func TestAdmin_NonAdminForbidden(t *testing.T) {
	app := newTestApp(t)
	registerUser(t, app, "alice") // becomes admin (first user)
	bob := registerUser(t, app, "bob")

	rw := doReq(app, "GET", "/api/admin/users", bob.Token, nil)
	if rw.Code != http.StatusForbidden {
		t.Fatalf("non-admin should get 403, got %d %s", rw.Code, rw.Body.String())
	}
}

func TestAdmin_ListUpdateDeleteUser_Cascades(t *testing.T) {
	app := newTestApp(t)
	admin := registerUser(t, app, "admin1") // first user -> admin
	bob := registerUser(t, app, "bob")
	docID := createDoc(t, app, bob.Token, "bob-doc")

	// list
	rw := doReq(app, "GET", "/api/admin/users", admin.Token, nil)
	if rw.Code != http.StatusOK {
		t.Fatalf("admin list users: %d %s", rw.Code, rw.Body.String())
	}
	var list struct {
		Items []struct {
			ID   string `json:"id"`
			Role string `json:"role"`
		} `json:"items"`
	}
	json.Unmarshal(rw.Body.Bytes(), &list)
	if len(list.Items) != 2 {
		t.Fatalf("expected 2 users, got %d", len(list.Items))
	}

	// update bob's role to admin then back to user
	rw = doReq(app, "PATCH", "/api/admin/users/"+bob.ID, admin.Token, map[string]any{"role": "admin"})
	if rw.Code != http.StatusOK {
		t.Fatalf("promote bob failed: %d %s", rw.Code, rw.Body.String())
	}

	// delete bob -> cascades to his doc
	rw = doReq(app, "DELETE", "/api/admin/users/"+bob.ID, admin.Token, nil)
	if rw.Code != http.StatusOK {
		t.Fatalf("delete bob failed: %d %s", rw.Code, rw.Body.String())
	}
	rw = doReq(app, "GET", "/d/"+docID+"/index.html", "", nil)
	if rw.Code != http.StatusNotFound {
		t.Fatalf("bob's doc asset should be gone after cascade delete, got %d", rw.Code)
	}
}

func TestAdmin_CannotDeleteOrDemoteSelf(t *testing.T) {
	app := newTestApp(t)
	admin := registerUser(t, app, "admin1")

	rw := doReq(app, "DELETE", "/api/admin/users/"+admin.ID, admin.Token, nil)
	if rw.Code != http.StatusBadRequest {
		t.Fatalf("self-delete should be rejected, got %d %s", rw.Code, rw.Body.String())
	}
	rw = doReq(app, "PATCH", "/api/admin/users/"+admin.ID, admin.Token, map[string]any{"role": "user"})
	if rw.Code != http.StatusBadRequest {
		t.Fatalf("self-demote should be rejected, got %d %s", rw.Code, rw.Body.String())
	}
}

func TestAdmin_CannotDeleteLastAdmin(t *testing.T) {
	app := newTestApp(t)
	admin := registerUser(t, app, "admin1")
	other := registerUser(t, app, "admin2")
	// promote other to admin, then demote/delete admin1 via other should be allowed;
	// but deleting the LAST remaining admin must be rejected.
	doReq(app, "PATCH", "/api/admin/users/"+other.ID, admin.Token, map[string]any{"role": "admin"})
	// role is baked into the JWT at issuance (stateless tokens) — `other` needs a fresh
	// token reflecting the new role before it can use admin-only endpoints itself.
	loginRW := doReq(app, "POST", "/api/auth/login", "", map[string]string{"username": "admin2", "password": "password123"})
	var loginResp struct {
		Token string `json:"token"`
	}
	json.Unmarshal(loginRW.Body.Bytes(), &loginResp)
	other.Token = loginResp.Token

	rw := doReq(app, "PATCH", "/api/admin/users/"+admin.ID, other.Token, map[string]any{"role": "user"})
	if rw.Code != http.StatusOK {
		t.Fatalf("demoting admin1 while another admin exists should succeed, got %d %s", rw.Code, rw.Body.String())
	}
	// now `other` is the only admin left; deleting it must be rejected
	rw = doReq(app, "DELETE", "/api/admin/users/"+other.ID, admin.Token, nil)
	// admin.Token still carries role=admin claim from its original JWT (stateless tokens),
	// which is enough to exercise the "last admin" guard itself.
	if rw.Code != http.StatusBadRequest {
		t.Fatalf("deleting the last admin should be rejected, got %d %s", rw.Code, rw.Body.String())
	}
}

// ---------- MCP ----------

func createMCPToken(t *testing.T, app *gin.Engine, jwt string) string {
	t.Helper()
	rw := doReq(app, "POST", "/api/mcp/tokens", jwt, map[string]any{"name": "test"})
	if rw.Code != http.StatusOK {
		t.Fatalf("create mcp token failed: %d %s", rw.Code, rw.Body.String())
	}
	var tok struct {
		Token string `json:"token"`
	}
	json.Unmarshal(rw.Body.Bytes(), &tok)
	return tok.Token
}

func mcpCall(app *gin.Engine, mcpToken, method string, params map[string]any) map[string]any {
	body := map[string]any{"jsonrpc": "2.0", "id": 1, "method": method}
	if params != nil {
		body["params"] = params
	}
	b, _ := json.Marshal(body)
	req := httptest.NewRequest("POST", "/mcp", bytes.NewReader(b))
	req.Header.Set("Authorization", "Bearer "+mcpToken)
	req.Header.Set("Content-Type", "application/json")
	rw := httptest.NewRecorder()
	app.ServeHTTP(rw, req)
	var out map[string]any
	json.Unmarshal(rw.Body.Bytes(), &out)
	return out
}

func mcpToolText(t *testing.T, resp map[string]any) string {
	t.Helper()
	result, _ := resp["result"].(map[string]any)
	content, _ := result["content"].([]any)
	if len(content) == 0 {
		t.Fatalf("no content in mcp response: %+v", resp)
	}
	first, _ := content[0].(map[string]any)
	text, _ := first["text"].(string)
	return text
}

func TestMCP_TokenScopedToOwner(t *testing.T) {
	app := newTestApp(t)
	alice := registerUser(t, app, "alice")
	bob := registerUser(t, app, "bob")

	aliceDocID := createDoc(t, app, alice.Token, "alice-doc")
	createDoc(t, app, bob.Token, "bob-doc")

	aliceMCP := createMCPToken(t, app, alice.Token)

	// list_documents only returns alice's own doc
	resp := mcpCall(app, aliceMCP, "tools/call", map[string]any{"name": "list_documents", "arguments": map[string]any{}})
	text := mcpToolText(t, resp)
	var listed struct {
		Items []struct {
			Title string `json:"title"`
		} `json:"items"`
	}
	if err := json.Unmarshal([]byte(text), &listed); err != nil {
		t.Fatalf("decode list_documents result: %v (raw=%s)", err, text)
	}
	if len(listed.Items) != 1 || listed.Items[0].Title != "alice-doc" {
		t.Fatalf("alice's mcp token should only see her own doc, got %+v", listed.Items)
	}

	// get_document on bob's doc id fails via alice's token
	var bobDocID string
	{
		rw := doReq(app, "GET", "/api/nodes", bob.Token, nil)
		var out struct {
			Items []struct {
				ID    string `json:"id"`
				Title string `json:"title"`
			} `json:"items"`
		}
		json.Unmarshal(rw.Body.Bytes(), &out)
		for _, it := range out.Items {
			if it.Title == "bob-doc" {
				bobDocID = it.ID
			}
		}
	}
	if bobDocID == "" {
		t.Fatalf("could not resolve bob's doc id")
	}
	resp = mcpCall(app, aliceMCP, "tools/call", map[string]any{"name": "get_document", "arguments": map[string]any{"id": bobDocID}})
	text = mcpToolText(t, resp)
	if text != "not found" {
		t.Fatalf("alice's mcp token should not see bob's doc, got %q", text)
	}

	// sanity: alice's own doc IS visible via get_document
	resp = mcpCall(app, aliceMCP, "tools/call", map[string]any{"name": "get_document", "arguments": map[string]any{"id": aliceDocID}})
	text = mcpToolText(t, resp)
	if text == "not found" {
		t.Fatalf("alice should be able to get_document her own doc")
	}
}

func TestMCP_TokensRESTScopedToOwner(t *testing.T) {
	app := newTestApp(t)
	alice := registerUser(t, app, "alice")
	bob := registerUser(t, app, "bob")

	createMCPToken(t, app, alice.Token)
	createMCPToken(t, app, bob.Token)

	rw := doReq(app, "GET", "/api/mcp/tokens", alice.Token, nil)
	var out struct {
		Items []map[string]any `json:"items"`
	}
	json.Unmarshal(rw.Body.Bytes(), &out)
	if len(out.Items) != 1 {
		t.Fatalf("alice should only see her own mcp token, got %d", len(out.Items))
	}
}
