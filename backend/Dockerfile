# ===========================
# Stage 1: Build Go backend
# ===========================
FROM golang:1.27-alpine AS builder

WORKDIR /app

# 🔧 install git so `go mod download` can fetch cloud.google.com modules
RUN apk upgrade --no-cache && apk add --no-cache git

# Enable modules and download deps
COPY go.mod go.sum ./
RUN go mod download

# Copy source
COPY . .

# Build statically linked binary
RUN CGO_ENABLED=0 GOOS=linux go build -o server .

# ===========================
# Stage 2: Minimal runtime
# ===========================
# static, not base: the binary is CGO_ENABLED=0, so it needs no libc or
# OpenSSL, and those were most of what Trivy found in base-debian12.
FROM gcr.io/distroless/static-debian13

WORKDIR /app

# Copy binary from builder
COPY --from=builder /app/server /app/server

# NOTE: config.yml is NOT baked in.
# In Kubernetes you'll mount it as /app/config.yml via ConfigMap.
# For local docker run: -v $(pwd)/config.yml:/app/config.yml:ro

EXPOSE 8080

ENTRYPOINT ["/app/server","-config","/app/config.yml"]
