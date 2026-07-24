package core

import (
	"context"
	"log/slog"
	"os"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	semconv "go.opentelemetry.io/otel/semconv/v1.27.0"
)

// InitOTel configures the global OTLP trace provider.
//
// When OTEL_EXPORTER_OTLP_ENDPOINT is set, traces are exported via OTLP/HTTP
// (e.g. Grafana Tempo or any OTel Collector). Set OTEL_EXPORTER_OTLP_HEADERS
// for auth (e.g. "Authorization=Basic <token>" for Grafana Cloud).
//
// When the env var is absent the call is a no-op — no traces, no overhead.
// Returns a shutdown func that must be called on process exit.
func InitOTel(ctx context.Context, serviceName string) func(context.Context) {
	endpoint := os.Getenv("OTEL_EXPORTER_OTLP_ENDPOINT")
	if endpoint == "" {
		// No endpoint — global provider stays at the SDK default no-op.
		return func(context.Context) {}
	}

	exp, err := otlptracehttp.New(ctx)
	if err != nil {
		slog.Error("OTel: OTLP exporter init failed — tracing disabled", "err", err)
		return func(context.Context) {}
	}

	res, err := resource.New(ctx,
		resource.WithAttributes(semconv.ServiceNameKey.String(serviceName)),
		resource.WithOS(),
		resource.WithProcess(),
	)
	if err != nil {
		// resource errors are non-fatal; continue with empty resource.
		res = resource.Empty()
	}

	tp := sdktrace.NewTracerProvider(
		sdktrace.WithBatcher(exp),
		sdktrace.WithResource(res),
		sdktrace.WithSampler(sdktrace.ParentBased(sdktrace.TraceIDRatioBased(0.2))),
	)
	otel.SetTracerProvider(tp)
	otel.SetTextMapPropagator(propagation.NewCompositeTextMapPropagator(
		propagation.TraceContext{},
		propagation.Baggage{},
	))

	slog.Info("OTel: tracing active", "endpoint", endpoint, "service", serviceName)
	return func(ctx context.Context) {
		if err := tp.Shutdown(ctx); err != nil {
			slog.Warn("OTel: shutdown error", "err", err)
		}
	}
}
