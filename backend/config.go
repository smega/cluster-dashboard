package main

import (
	"log"
	"os"

	"gopkg.in/yaml.v3"
)

type Config struct {
	Server struct {
		Address        string   `yaml:"address"`
		AllowedOrigins []string `yaml:"allowed_origins"`
	} `yaml:"server"`
	Mongo struct {
		URI      string `yaml:"uri"`
		Database string `yaml:"database"`
	} `yaml:"mongo"`
	Auth struct {
		JWTSecret       string `yaml:"jwt_secret"`
		TokenTTLMinutes int    `yaml:"token_ttl_minutes"`
		BcryptCost      int    `yaml:"bcrypt_cost"`
	} `yaml:"auth"`

	Kube struct {
		Kubeconfig string `yaml:"kubeconfig"` // for local dev only; empty in GKE
	} `yaml:"kube"`
}

var cfg Config

func loadConfig(path string) {
	data, err := os.ReadFile(path)
	if err != nil {
		log.Fatalf("read config: %v", err)
	}
	if err := yaml.Unmarshal(data, &cfg); err != nil {
		log.Fatalf("parse config: %v", err)
	}

	if cfg.Server.Address == "" {
		cfg.Server.Address = ":8080"
	}
	if cfg.Auth.TokenTTLMinutes <= 0 {
		cfg.Auth.TokenTTLMinutes = 60
	}
	if cfg.Auth.BcryptCost == 0 {
		cfg.Auth.BcryptCost = 12
	}
}
