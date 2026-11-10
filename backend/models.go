package main

import (
	"time"

	"go.mongodb.org/mongo-driver/bson/primitive"
)

type User struct {
	ID           primitive.ObjectID `bson:"_id,omitempty" json:"id"`
	Email        string             `bson:"email" json:"email"`
	PasswordHash string             `bson:"password_hash" json:"-"`
	Role         string             `bson:"role,omitempty" json:"role,omitempty"`
	Disabled     bool               `bson:"disabled,omitempty" json:"disabled"`
	CreatedAt    time.Time          `bson:"created_at" json:"createdAt"`
}
