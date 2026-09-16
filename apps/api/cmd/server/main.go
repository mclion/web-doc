package main

import (
	"log"

	"github.com/xiaofengguo/web-doc/api/internal/config"
	"github.com/xiaofengguo/web-doc/api/internal/db"
	"github.com/xiaofengguo/web-doc/api/internal/handler"
	"github.com/xiaofengguo/web-doc/api/internal/router"
	"github.com/xiaofengguo/web-doc/api/internal/storage"
	"github.com/xiaofengguo/web-doc/api/internal/watcher"
)

func main() {
	cfg := config.Load()
	log.Printf("[web-doc] storage dir: %s", cfg.StorageDir)
	log.Printf("[web-doc] listening:   %s", cfg.Addr)
	if cfg.WebRoot != "" {
		log.Printf("[web-doc] web root:    %s", cfg.WebRoot)
	}

	st, err := storage.New(cfg.StorageDir)
	if err != nil {
		log.Fatal(err)
	}
	d, err := db.Open(cfg.DSN)
	if err != nil {
		log.Fatal(err)
	}
	hub, err := watcher.NewHub(cfg.StorageDir)
	if err != nil {
		log.Fatal(err)
	}

	h := handler.New(d, st, hub)
	h.JWTSecret = cfg.JWTSecret
	h.DisableRegister = cfg.DisableRegister

	app := router.New(h, cfg)
	if err := app.Run(cfg.Addr); err != nil {
		log.Fatal(err)
	}
}
