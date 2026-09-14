# Keep in step with the toolchain line in go.mod and go-version in deploy.yml.
# 1.25.11 shipped 8 standard-library CVEs (net/http, crypto/tls, net/url,
# html/template, encoding/xml, encoding/asn1) that are fixed by 1.25.13.
FROM golang:1.25.14-alpine AS builder
ENV GOTOOLCHAIN=auto
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
