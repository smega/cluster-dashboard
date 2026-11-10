package main

import (
	"context"
	"log"

	"go.mongodb.org/mongo-driver/mongo"
	"go.mongodb.org/mongo-driver/mongo/options"
)

var (
	mongoClient *mongo.Client
	userColl    *mongo.Collection
)

func initMongo(ctx context.Context) error {
	client, err := mongo.Connect(ctx, options.Client().ApplyURI(cfg.Mongo.URI))
	if err != nil {
		return err
	}

	if err := client.Ping(ctx, nil); err != nil {
		return err
	}

	mongoClient = client
	db := client.Database(cfg.Mongo.Database)
	userColl = db.Collection("users")

	log.Printf("Connected to MongoDB database %s", cfg.Mongo.Database)
	return nil
}
