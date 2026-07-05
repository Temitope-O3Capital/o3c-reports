package handlers

import (
	"net/http"
	"strconv"
	"strings"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

var (
	httpRequestsTotal = prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "o3c_http_requests_total",
		Help: "Total number of HTTP requests by method, route group, and status code.",
	}, []string{"method", "route", "status"})

	httpDurationSeconds = prometheus.NewHistogramVec(prometheus.HistogramOpts{
		Name:    "o3c_http_request_duration_seconds",
		Help:    "HTTP request latency histogram by method and route group.",
		Buckets: prometheus.DefBuckets,
	}, []string{"method", "route"})
)

func init() {
	prometheus.MustRegister(httpRequestsTotal, httpDurationSeconds)
}

// MetricsHandler serves the Prometheus /metrics scrape endpoint.
func MetricsHandler() http.Handler {
	return promhttp.Handler()
}

// PrometheusMiddleware records request count and latency per route group.
func PrometheusMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		route := routeGroup(r.URL.Path)
		timer := prometheus.NewTimer(httpDurationSeconds.WithLabelValues(r.Method, route))

		rw := &statusWriter{ResponseWriter: w, status: 200}
		next.ServeHTTP(rw, r)

		timer.ObserveDuration()
		httpRequestsTotal.WithLabelValues(r.Method, route, strconv.Itoa(rw.status)).Inc()
	})
}

// routeGroup collapses specific paths to a label-safe group name.
func routeGroup(path string) string {
	for _, seg := range []string{
		"overview", "transactions", "collections", "recovery", "sales", "cards",
		"loans", "los", "admin", "crm", "hr", "compliance", "reports", "bi",
		"credit-portfolio", "fixed-deposit", "settlement", "uploads",
		"reconciliation", "kpi", "batch", "collections-ops", "recovery-ops",
		"approvals", "customer360", "customer-service", "risk", "helpdesk",
		"campaigns", "auth", "notifications", "finance", "payroll",
	} {
		if strings.Contains(path, "/api/"+seg) {
			return "/api/" + seg
		}
	}
	if strings.HasPrefix(path, "/api/") {
		return "/api/other"
	}
	return "other"
}

// statusWriter wraps ResponseWriter to capture the HTTP status code.
type statusWriter struct {
	http.ResponseWriter
	status int
}

func (sw *statusWriter) WriteHeader(code int) {
	sw.status = code
	sw.ResponseWriter.WriteHeader(code)
}
