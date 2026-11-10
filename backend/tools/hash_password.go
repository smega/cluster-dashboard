package main

import (
	"flag"
	"fmt"
	"log"

	"golang.org/x/crypto/bcrypt"
)

func main() {
	pw := flag.String("password", "", "password to hash")
	cost := flag.Int("cost", bcrypt.DefaultCost, "bcrypt cost (10-14 recommended)")
	flag.Parse()

	if *pw == "" {
		log.Fatal("password is required; use -password")
	}

	hash, err := bcrypt.GenerateFromPassword([]byte(*pw), *cost)
	if err != nil {
		log.Fatal(err)
	}

	fmt.Println(string(hash))
}
