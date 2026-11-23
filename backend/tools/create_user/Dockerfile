FROM golang:1.25-alpine AS builder
WORKDIR /app
RUN apk upgrade --no-cache && apk add --no-cache git
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -o create_user ./tools/create_user

FROM gcr.io/distroless/base-debian12
COPY --from=builder /app/create_user /app/create_user
ENTRYPOINT ["/app/create_user"]
