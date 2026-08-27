package main

import (
	"example.com/go-app/internal/store"
	"github.com/gin-gonic/gin"
)

type Server struct {
	Store *store.Store
}

func main() {
	r := gin.Default()
	r.GET("/health", func(c *gin.Context) {
		s := &Server{Store: store.New()}
		_ = s
	})
	r.Run(":8080")
}