package main

import (
	"context"
	"flag"
	"log"
	"time"
)

func main() {
	cfgPath := flag.String("config", "config.yml", "path to config.yml")
	flag.Parse()

	loadConfig(*cfgPath)

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	if err := initMongo(ctx); err != nil {
		log.Fatalf("mongo init: %v", err)
	}

	if err := initKube(ctx); err != nil {
		log.Fatalf("kube init: %v", err)
	}

	topo = NewTopologyManager(kubeClient)
	go topo.Start(context.Background())

	r := setupRouter()

	log.Printf("Listening on %s", cfg.Server.Address)
	if err := r.Run(cfg.Server.Address); err != nil {
		log.Fatalf("server error: %v", err)
	}
}
