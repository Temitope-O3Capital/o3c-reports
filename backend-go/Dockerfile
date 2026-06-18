FROM golang:1.25-alpine AS builder
WORKDIR /build
RUN apk add --no-cache git

COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o server .

# ── Runtime ────────────────────────────────────────────────────────────────────
FROM alpine:3.19 AS runtime
RUN apk add --no-cache ca-certificates tzdata && \
    addgroup -S app && adduser -S app -G app
WORKDIR /app
COPY --from=builder /build/server .
RUN chown app:app /app/server
USER app

EXPOSE 8000
ENV TZ=Africa/Lagos

CMD ["./server"]
