package main

import (
	"context"
	"log"
	"os"
	"strings"
	"time"

	"go.mongodb.org/mongo-driver/bson"
	"go.mongodb.org/mongo-driver/mongo"
	"go.mongodb.org/mongo-driver/mongo/options"
)

// One-off job: upserts a single user into the dashboard's "users" collection.
// Reads connection info from the same env vars the backend uses (MONGO_URI),
// plus NEW_USER_EMAIL / NEW_USER_PASSWORD_HASH / NEW_USER_ROLE for the row.
func main() {
	uri := os.Getenv("MONGO_URI")
	db := os.Getenv("MONGO_DB")
	email := strings.ToLower(strings.TrimSpace(os.Getenv("NEW_USER_EMAIL")))
	hash := os.Getenv("NEW_USER_PASSWORD_HASH")
	role := os.Getenv("NEW_USER_ROLE")

	if uri == "" || db == "" || email == "" || hash == "" {
		log.Fatal("MONGO_URI, MONGO_DB, NEW_USER_EMAIL and NEW_USER_PASSWORD_HASH are required")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	client, err := mongo.Connect(ctx, options.Client().ApplyURI(uri))
	if err != nil {
		log.Fatalf("connect: %v", err)
	}
	defer client.Disconnect(ctx)

	coll := client.Database(db).Collection("users")

	_, err = coll.UpdateOne(
		ctx,
		bson.M{"email": email},
		bson.M{
			"$set": bson.M{
				"email":         email,
				"password_hash": hash,
				"role":          role,
				"disabled":      false,
			},
			"$setOnInsert": bson.M{
				"created_at": time.Now(),
			},
		},
		options.Update().SetUpsert(true),
	)
	if err != nil {
		log.Fatalf("upsert user: %v", err)
	}

	log.Printf("user %q upserted with role %q", email, role)
}
