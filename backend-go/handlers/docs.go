package handlers

import "net/http"

// APIDocs serves Swagger UI pointing at /api/docs/spec.
func APIDocs() http.HandlerFunc {
	const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>O3 Capital API Reference</title>
  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5.17.14/swagger-ui.css">
  <style>
    body { margin: 0; }
    .topbar { display: none !important; }
  </style>
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://unpkg.com/swagger-ui-dist@5.17.14/swagger-ui-bundle.js"></script>
  <script>
    SwaggerUIBundle({
      url: "/api/docs/spec",
      dom_id: "#swagger-ui",
      deepLinking: true,
      persistAuthorization: true,
      presets: [SwaggerUIBundle.presets.apis],
      layout: "BaseLayout",
    })
  </script>
</body>
</html>`
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Write([]byte(html)) //nolint:errcheck
	}
}

// APISpec returns the raw OpenAPI 3.0 JSON spec.
func APISpec() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Write([]byte(openapiSpec)) //nolint:errcheck
	}
}

const openapiSpec = `{
  "openapi": "3.0.3",
  "info": {
    "title": "O3 Capital Workspace API",
    "version": "1.0.0",
    "description": "Internal staff platform API — loan origination, cards, collections, helpdesk, sales, finance, HR, and compliance. All endpoints require Bearer JWT unless noted as public.",
    "contact": { "name": "O3 Capital IT", "email": "it@o3capital.ng" }
  },
  "servers": [
    { "url": "http://localhost:8000", "description": "Local dev" },
    { "url": "https://api.o3capital.ng", "description": "Production (Railway)" }
  ],
  "security": [{ "bearerAuth": [] }],
  "components": {
    "securitySchemes": {
      "bearerAuth": { "type": "http", "scheme": "bearer", "bearerFormat": "JWT" }
    },
    "schemas": {
      "Error": {
        "type": "object",
        "properties": { "detail": { "type": "string" } }
      },
      "Envelope": {
        "type": "object",
        "properties": {
          "data": {},
          "data_source": { "type": "string", "example": "supabase_snapshot" },
          "data_as_of": { "type": "string", "format": "date-time" }
        }
      },
      "LoginRequest": {
        "type": "object",
        "required": ["email", "password"],
        "properties": {
          "email": { "type": "string", "format": "email" },
          "password": { "type": "string" }
        }
      },
      "TokenResponse": {
        "type": "object",
        "properties": {
          "access_token": { "type": "string" },
          "token_type": { "type": "string", "example": "bearer" },
          "expires_in": { "type": "integer", "example": 28800 },
          "totp_required": { "type": "boolean" },
          "totp_ticket": { "type": "string" }
        }
      },
      "User": {
        "type": "object",
        "properties": {
          "id": { "type": "integer" },
          "email": { "type": "string" },
          "full_name": { "type": "string" },
          "role": { "type": "string" },
          "branch": { "type": "string" },
          "is_active": { "type": "boolean" }
        }
      },
      "CreditApplication": {
        "type": "object",
        "properties": {
          "id": { "type": "integer" },
          "application_ref": { "type": "string", "example": "APP-2026-001234" },
          "applicant_name": { "type": "string" },
          "applicant_cif": { "type": "string" },
          "product_type": { "type": "string", "enum": ["salary_loan","business_loan","personal_loan","credit_card"] },
          "amount_kobo": { "type": "integer", "description": "Requested amount in kobo (divide by 100 for naira)" },
          "tenor_months": { "type": "integer" },
          "status": { "type": "string", "enum": ["pending","under_review","approved","declined","disbursed","cancelled"] },
          "assigned_officer": { "type": "string" },
          "created_at": { "type": "string", "format": "date-time" },
          "updated_at": { "type": "string", "format": "date-time" }
        }
      },
      "HelpdeskTicket": {
        "type": "object",
        "properties": {
          "id": { "type": "integer" },
          "ticket_ref": { "type": "string", "example": "HD-2026-00042" },
          "subject": { "type": "string" },
          "ticket_type": { "type": "string" },
          "status": { "type": "string", "enum": ["open","pending","resolved","closed","merged"] },
          "priority": { "type": "string", "enum": ["low","medium","high","urgent"] },
          "channel": { "type": "string", "enum": ["email","phone","whatsapp","walk_in","web"] },
          "customer_name": { "type": "string" },
          "customer_cif": { "type": "string" },
          "assigned_agent_id": { "type": "integer" },
          "sla_deadline": { "type": "string", "format": "date-time" },
          "created_at": { "type": "string", "format": "date-time" }
        }
      },
      "SalesTarget": {
        "type": "object",
        "properties": {
          "id": { "type": "integer" },
          "officer_id": { "type": "integer" },
          "officer_name": { "type": "string" },
          "period_month": { "type": "string", "example": "2026-07" },
          "target_count": { "type": "integer" },
          "target_volume_kobo": { "type": "integer" },
          "actual_count": { "type": "integer" },
          "actual_volume_kobo": { "type": "integer" }
        }
      }
    }
  },
  "paths": {
    "/api/auth/token": {
      "post": {
        "tags": ["Auth"],
        "summary": "Login — get access token",
        "security": [],
        "requestBody": {
          "required": true,
          "content": { "application/json": { "schema": { "$ref": "#/components/schemas/LoginRequest" } } }
        },
        "responses": {
          "200": { "description": "Token issued (or TOTP required)", "content": { "application/json": { "schema": { "$ref": "#/components/schemas/TokenResponse" } } } },
          "401": { "description": "Invalid credentials", "content": { "application/json": { "schema": { "$ref": "#/components/schemas/Error" } } } }
        }
      }
    },
    "/api/auth/totp/challenge": {
      "post": {
        "tags": ["Auth"],
        "summary": "Complete TOTP MFA challenge",
        "security": [],
        "requestBody": {
          "required": true,
          "content": { "application/json": { "schema": {
            "type": "object",
            "required": ["totp_ticket", "code"],
            "properties": {
              "totp_ticket": { "type": "string" },
              "code": { "type": "string", "example": "123456" }
            }
          }}}
        },
        "responses": {
          "200": { "description": "Full access token issued", "content": { "application/json": { "schema": { "$ref": "#/components/schemas/TokenResponse" } } } },
          "401": { "description": "Invalid or expired code" }
        }
      }
    },
    "/api/auth/refresh": {
      "post": {
        "tags": ["Auth"],
        "summary": "Refresh access token using HttpOnly refresh cookie",
        "security": [],
        "responses": {
          "200": { "description": "New access token", "content": { "application/json": { "schema": { "$ref": "#/components/schemas/TokenResponse" } } } },
          "401": { "description": "Refresh token invalid or expired" }
        }
      }
    },
    "/api/auth/me": {
      "get": {
        "tags": ["Auth"],
        "summary": "Get current authenticated user",
        "responses": {
          "200": { "description": "Current user", "content": { "application/json": { "schema": { "$ref": "#/components/schemas/User" } } } }
        }
      }
    },
    "/api/auth/logout": {
      "post": {
        "tags": ["Auth"],
        "summary": "Invalidate refresh token and clear cookie",
        "responses": { "204": { "description": "Logged out" } }
      }
    },
    "/api/los/applications": {
      "get": {
        "tags": ["Credit Applications"],
        "summary": "List credit applications",
        "parameters": [
          { "name": "status", "in": "query", "schema": { "type": "string" } },
          { "name": "product_type", "in": "query", "schema": { "type": "string" } },
          { "name": "from", "in": "query", "schema": { "type": "string", "format": "date" } },
          { "name": "to", "in": "query", "schema": { "type": "string", "format": "date" } },
          { "name": "q", "in": "query", "description": "Search by name or CIF", "schema": { "type": "string" } },
          { "name": "page", "in": "query", "schema": { "type": "integer", "default": 1 } },
          { "name": "limit", "in": "query", "schema": { "type": "integer", "default": 50, "maximum": 200 } }
        ],
        "responses": {
          "200": { "description": "Paginated applications list", "content": { "application/json": { "schema": { "allOf": [{ "$ref": "#/components/schemas/Envelope" }] } } } }
        }
      },
      "post": {
        "tags": ["Credit Applications"],
        "summary": "Create a new credit application",
        "requestBody": {
          "required": true,
          "content": { "application/json": { "schema": {
            "type": "object",
            "required": ["applicant_cif","product_type","amount_kobo","tenor_months"],
            "properties": {
              "applicant_cif": { "type": "string" },
              "product_type": { "type": "string", "enum": ["salary_loan","business_loan","personal_loan","credit_card"] },
              "amount_kobo": { "type": "integer" },
              "tenor_months": { "type": "integer" },
              "purpose": { "type": "string" },
              "employer_id": { "type": "integer" }
            }
          }}}
        },
        "responses": {
          "201": { "description": "Application created", "content": { "application/json": { "schema": { "$ref": "#/components/schemas/CreditApplication" } } } },
          "422": { "description": "Validation error" }
        }
      }
    },
    "/api/los/applications/{id}": {
      "get": {
        "tags": ["Credit Applications"],
        "summary": "Get application detail",
        "parameters": [{ "name": "id", "in": "path", "required": true, "schema": { "type": "integer" } }],
        "responses": {
          "200": { "description": "Application detail", "content": { "application/json": { "schema": { "$ref": "#/components/schemas/CreditApplication" } } } },
          "404": { "description": "Not found" }
        }
      }
    },
    "/api/los/applications/{id}/status": {
      "patch": {
        "tags": ["Credit Applications"],
        "summary": "Update application status (approve / decline / disburse)",
        "parameters": [{ "name": "id", "in": "path", "required": true, "schema": { "type": "integer" } }],
        "requestBody": {
          "required": true,
          "content": { "application/json": { "schema": {
            "type": "object",
            "required": ["status"],
            "properties": {
              "status": { "type": "string", "enum": ["under_review","approved","declined","disbursed","cancelled"] },
              "reason": { "type": "string" },
              "approved_amount_kobo": { "type": "integer" }
            }
          }}}
        },
        "responses": {
          "200": { "description": "Status updated" },
          "400": { "description": "Invalid status transition" }
        }
      }
    },
    "/api/los/queue": {
      "get": {
        "tags": ["Credit Applications"],
        "summary": "Applications pending officer review (status=pending or under_review)",
        "responses": {
          "200": { "description": "Queue list", "content": { "application/json": { "schema": { "$ref": "#/components/schemas/Envelope" } } } }
        }
      }
    },
    "/api/helpdesk/tickets": {
      "get": {
        "tags": ["Helpdesk"],
        "summary": "List helpdesk tickets",
        "parameters": [
          { "name": "status", "in": "query", "schema": { "type": "string" } },
          { "name": "priority", "in": "query", "schema": { "type": "string" } },
          { "name": "channel", "in": "query", "schema": { "type": "string" } },
          { "name": "assigned_to", "in": "query", "schema": { "type": "integer" } },
          { "name": "q", "in": "query", "schema": { "type": "string" } },
          { "name": "page", "in": "query", "schema": { "type": "integer", "default": 1 } }
        ],
        "responses": {
          "200": { "description": "Ticket list", "content": { "application/json": { "schema": { "$ref": "#/components/schemas/Envelope" } } } }
        }
      },
      "post": {
        "tags": ["Helpdesk"],
        "summary": "Create helpdesk ticket",
        "requestBody": {
          "required": true,
          "content": { "application/json": { "schema": {
            "type": "object",
            "required": ["subject","ticket_type","channel"],
            "properties": {
              "subject": { "type": "string" },
              "ticket_type": { "type": "string" },
              "channel": { "type": "string" },
              "priority": { "type": "string", "default": "medium" },
              "customer_cif": { "type": "string" },
              "body": { "type": "string" }
            }
          }}}
        },
        "responses": {
          "201": { "description": "Ticket created", "content": { "application/json": { "schema": { "$ref": "#/components/schemas/HelpdeskTicket" } } } }
        }
      }
    },
    "/api/helpdesk/tickets/{id}": {
      "get": {
        "tags": ["Helpdesk"],
        "summary": "Get ticket with messages",
        "parameters": [{ "name": "id", "in": "path", "required": true, "schema": { "type": "integer" } }],
        "responses": {
          "200": { "description": "Ticket detail", "content": { "application/json": { "schema": { "$ref": "#/components/schemas/HelpdeskTicket" } } } }
        }
      }
    },
    "/api/helpdesk/tickets/{id}/status": {
      "patch": {
        "tags": ["Helpdesk"],
        "summary": "Update ticket status",
        "parameters": [{ "name": "id", "in": "path", "required": true, "schema": { "type": "integer" } }],
        "requestBody": {
          "required": true,
          "content": { "application/json": { "schema": {
            "type": "object",
            "required": ["status"],
            "properties": {
              "status": { "type": "string", "enum": ["open","pending","resolved","closed"] },
              "resolution_note": { "type": "string" }
            }
          }}}
        },
        "responses": { "200": { "description": "Status updated" } }
      }
    },
    "/api/helpdesk/tickets/{id}/messages": {
      "post": {
        "tags": ["Helpdesk"],
        "summary": "Add message/reply to ticket",
        "parameters": [{ "name": "id", "in": "path", "required": true, "schema": { "type": "integer" } }],
        "requestBody": {
          "required": true,
          "content": { "application/json": { "schema": {
            "type": "object",
            "required": ["body"],
            "properties": {
              "body": { "type": "string" },
              "is_internal": { "type": "boolean", "default": false }
            }
          }}}
        },
        "responses": { "201": { "description": "Message added" } }
      }
    },
    "/api/helpdesk/tickets/{id}/merge": {
      "post": {
        "tags": ["Helpdesk"],
        "summary": "Merge ticket into another",
        "parameters": [{ "name": "id", "in": "path", "required": true, "schema": { "type": "integer" } }],
        "requestBody": {
          "required": true,
          "content": { "application/json": { "schema": {
            "type": "object",
            "required": ["into_ticket_id"],
            "properties": { "into_ticket_id": { "type": "integer" } }
          }}}
        },
        "responses": { "200": { "description": "Merged" } }
      }
    },
    "/api/helpdesk/email-ingest": {
      "post": {
        "tags": ["Helpdesk"],
        "summary": "Poll MS Graph inbox and create tickets from unread emails",
        "description": "Triggered by batch scheduler. Uses HELPDESK_INBOX_ADDRESS + MS Graph credentials from api_credentials table.",
        "responses": {
          "200": { "description": "Ingest result", "content": { "application/json": { "schema": {
            "type": "object",
            "properties": {
              "created": { "type": "integer" },
              "skipped": { "type": "integer" }
            }
          }}}}
        }
      }
    },
    "/api/collections-ops/queue": {
      "get": {
        "tags": ["Collections"],
        "summary": "Collections queue — accounts requiring action",
        "parameters": [
          { "name": "dpd_min", "in": "query", "schema": { "type": "integer" } },
          { "name": "dpd_max", "in": "query", "schema": { "type": "integer" } },
          { "name": "assigned_to", "in": "query", "schema": { "type": "integer" } },
          { "name": "page", "in": "query", "schema": { "type": "integer", "default": 1 } }
        ],
        "responses": {
          "200": { "description": "Collections queue", "content": { "application/json": { "schema": { "$ref": "#/components/schemas/Envelope" } } } }
        }
      }
    },
    "/api/collections-ops/promises": {
      "get": {
        "tags": ["Collections"],
        "summary": "List promise-to-pay records",
        "parameters": [
          { "name": "status", "in": "query", "schema": { "type": "string", "enum": ["active","broken","kept","cancelled"] } },
          { "name": "due_from", "in": "query", "schema": { "type": "string", "format": "date" } },
          { "name": "due_to", "in": "query", "schema": { "type": "string", "format": "date" } }
        ],
        "responses": {
          "200": { "description": "PTP list", "content": { "application/json": { "schema": { "$ref": "#/components/schemas/Envelope" } } } }
        }
      },
      "post": {
        "tags": ["Collections"],
        "summary": "Create promise-to-pay",
        "requestBody": {
          "required": true,
          "content": { "application/json": { "schema": {
            "type": "object",
            "required": ["loan_account_id","promise_date","amount_kobo"],
            "properties": {
              "loan_account_id": { "type": "integer" },
              "promise_date": { "type": "string", "format": "date" },
              "amount_kobo": { "type": "integer" },
              "note": { "type": "string" }
            }
          }}}
        },
        "responses": { "201": { "description": "PTP created" } }
      }
    },
    "/api/finance/overview": {
      "get": {
        "tags": ["Finance"],
        "summary": "Finance overview KPIs",
        "responses": {
          "200": { "description": "Finance overview data", "content": { "application/json": { "schema": { "$ref": "#/components/schemas/Envelope" } } } }
        }
      }
    },
    "/api/finance/fd-maturity": {
      "get": {
        "tags": ["Finance"],
        "summary": "Fixed deposits maturing within a horizon",
        "parameters": [
          { "name": "horizon_days", "in": "query", "schema": { "type": "integer", "default": 30 } }
        ],
        "responses": {
          "200": { "description": "FD maturity list", "content": { "application/json": { "schema": { "$ref": "#/components/schemas/Envelope" } } } }
        }
      }
    },
    "/api/finance/manual-postings": {
      "get": {
        "tags": ["Finance"],
        "summary": "List manual posting requests",
        "responses": { "200": { "description": "Manual postings", "content": { "application/json": { "schema": { "$ref": "#/components/schemas/Envelope" } } } } }
      },
      "post": {
        "tags": ["Finance"],
        "summary": "Initiate manual posting (requires Finance Head approval)",
        "requestBody": {
          "required": true,
          "content": { "application/json": { "schema": {
            "type": "object",
            "required": ["debit_account","credit_account","amount_kobo","narration"],
            "properties": {
              "debit_account": { "type": "string" },
              "credit_account": { "type": "string" },
              "amount_kobo": { "type": "integer" },
              "narration": { "type": "string" },
              "value_date": { "type": "string", "format": "date" }
            }
          }}}
        },
        "responses": { "201": { "description": "Posting request created" } }
      }
    },
    "/api/finance/manual-postings/{id}/approve": {
      "patch": {
        "tags": ["Finance"],
        "summary": "Approve or reject manual posting",
        "parameters": [{ "name": "id", "in": "path", "required": true, "schema": { "type": "integer" } }],
        "requestBody": {
          "required": true,
          "content": { "application/json": { "schema": {
            "type": "object",
            "required": ["action"],
            "properties": {
              "action": { "type": "string", "enum": ["approve","reject"] },
              "note": { "type": "string" }
            }
          }}}
        },
        "responses": { "200": { "description": "Decision recorded" } }
      }
    },
    "/api/finance/gl-accounts": {
      "get": {
        "tags": ["Finance"],
        "summary": "Chart of accounts",
        "responses": { "200": { "description": "GL accounts", "content": { "application/json": { "schema": { "$ref": "#/components/schemas/Envelope" } } } } }
      },
      "post": {
        "tags": ["Finance"],
        "summary": "Create GL account",
        "requestBody": {
          "required": true,
          "content": { "application/json": { "schema": {
            "type": "object",
            "required": ["code","name","account_type"],
            "properties": {
              "code": { "type": "string", "example": "4001" },
              "name": { "type": "string" },
              "account_type": { "type": "string", "enum": ["asset","liability","income","expense","equity"] },
              "parent_code": { "type": "string" }
            }
          }}}
        },
        "responses": { "201": { "description": "Account created" } }
      }
    },
    "/api/sales/targets": {
      "get": {
        "tags": ["Sales"],
        "summary": "Sales targets vs actuals",
        "parameters": [
          { "name": "period", "in": "query", "description": "YYYY-MM", "schema": { "type": "string" } },
          { "name": "officer_id", "in": "query", "schema": { "type": "integer" } }
        ],
        "responses": {
          "200": { "description": "Targets list", "content": { "application/json": { "schema": { "allOf": [{ "$ref": "#/components/schemas/Envelope" }] } } } }
        }
      },
      "post": {
        "tags": ["Sales"],
        "summary": "Set/update sales target for an officer-period",
        "requestBody": {
          "required": true,
          "content": { "application/json": { "schema": {
            "type": "object",
            "required": ["officer_id","period_month","target_count","target_volume_kobo"],
            "properties": {
              "officer_id": { "type": "integer" },
              "period_month": { "type": "string", "example": "2026-07" },
              "target_count": { "type": "integer" },
              "target_volume_kobo": { "type": "integer" }
            }
          }}}
        },
        "responses": { "201": { "description": "Target upserted", "content": { "application/json": { "schema": { "$ref": "#/components/schemas/SalesTarget" } } } } }
      }
    },
    "/api/sales/by-lead-source": {
      "get": {
        "tags": ["Sales"],
        "summary": "Origination breakdown by lead source",
        "parameters": [
          { "name": "from", "in": "query", "schema": { "type": "string", "format": "date" } },
          { "name": "to", "in": "query", "schema": { "type": "string", "format": "date" } }
        ],
        "responses": {
          "200": { "description": "Lead source breakdown", "content": { "application/json": { "schema": {
            "type": "object",
            "properties": { "data": { "type": "array", "items": {
              "type": "object",
              "properties": {
                "lead_source": { "type": "string" },
                "total_applications": { "type": "integer" },
                "approved": { "type": "integer" },
                "disbursement_kobo": { "type": "integer" }
              }
            }}}
          }}}}
        }
      }
    },
    "/api/crm/contacts": {
      "get": {
        "tags": ["CRM"],
        "summary": "List CRM contacts",
        "parameters": [
          { "name": "q", "in": "query", "schema": { "type": "string" } },
          { "name": "stage", "in": "query", "schema": { "type": "string" } },
          { "name": "page", "in": "query", "schema": { "type": "integer", "default": 1 } }
        ],
        "responses": { "200": { "description": "Contacts list", "content": { "application/json": { "schema": { "$ref": "#/components/schemas/Envelope" } } } } }
      },
      "post": {
        "tags": ["CRM"],
        "summary": "Create CRM contact",
        "requestBody": {
          "required": true,
          "content": { "application/json": { "schema": {
            "type": "object",
            "required": ["full_name"],
            "properties": {
              "full_name": { "type": "string" },
              "email": { "type": "string" },
              "phone": { "type": "string" },
              "employer": { "type": "string" },
              "lead_source": { "type": "string", "enum": ["referral","campaign","walk_in","digital","corporate"] },
              "stage": { "type": "string" }
            }
          }}}
        },
        "responses": { "201": { "description": "Contact created" } }
      }
    },
    "/api/crm/deals": {
      "get": {
        "tags": ["CRM"],
        "summary": "List CRM deals / pipeline",
        "responses": { "200": { "description": "Deals list", "content": { "application/json": { "schema": { "$ref": "#/components/schemas/Envelope" } } } } }
      }
    },
    "/api/admin/users": {
      "get": {
        "tags": ["Admin"],
        "summary": "List workspace users",
        "parameters": [
          { "name": "role", "in": "query", "schema": { "type": "string" } },
          { "name": "is_active", "in": "query", "schema": { "type": "boolean" } },
          { "name": "q", "in": "query", "schema": { "type": "string" } }
        ],
        "responses": { "200": { "description": "User list", "content": { "application/json": { "schema": { "$ref": "#/components/schemas/Envelope" } } } } }
      },
      "post": {
        "tags": ["Admin"],
        "summary": "Create workspace user",
        "requestBody": {
          "required": true,
          "content": { "application/json": { "schema": {
            "type": "object",
            "required": ["email","full_name","role","password"],
            "properties": {
              "email": { "type": "string" },
              "full_name": { "type": "string" },
              "role": { "type": "string" },
              "branch": { "type": "string" },
              "password": { "type": "string" }
            }
          }}}
        },
        "responses": { "201": { "description": "User created" } }
      }
    },
    "/api/admin/integrations": {
      "get": {
        "tags": ["Admin"],
        "summary": "List vendor integrations with health status",
        "responses": { "200": { "description": "Integration registry", "content": { "application/json": { "schema": { "$ref": "#/components/schemas/Envelope" } } } } }
      },
      "post": {
        "tags": ["Admin"],
        "summary": "Register vendor integration",
        "requestBody": {
          "required": true,
          "content": { "application/json": { "schema": {
            "type": "object",
            "required": ["name","type"],
            "properties": {
              "name": { "type": "string", "example": "SendGrid" },
              "type": { "type": "string", "enum": ["email","sms","voice","banking","storage","hosting","security"] },
              "health_url": { "type": "string" },
              "owner": { "type": "string" },
              "api_key_expires_at": { "type": "string", "format": "date" },
              "notes": { "type": "string" }
            }
          }}}
        },
        "responses": { "201": { "description": "Integration registered" } }
      }
    },
    "/api/admin/integrations/{id}/health": {
      "get": {
        "tags": ["Admin"],
        "summary": "Ping integration and return latency + status",
        "parameters": [{ "name": "id", "in": "path", "required": true, "schema": { "type": "integer" } }],
        "responses": {
          "200": { "description": "Health result", "content": { "application/json": { "schema": {
            "type": "object",
            "properties": {
              "status_code": { "type": "integer" },
              "latency_ms": { "type": "integer" },
              "ok": { "type": "boolean" }
            }
          }}}}
        }
      }
    },
    "/api/hr/employees": {
      "get": {
        "tags": ["HR"],
        "summary": "List employees",
        "parameters": [
          { "name": "department", "in": "query", "schema": { "type": "string" } },
          { "name": "status", "in": "query", "schema": { "type": "string", "enum": ["active","on_leave","exited"] } },
          { "name": "q", "in": "query", "schema": { "type": "string" } },
          { "name": "page", "in": "query", "schema": { "type": "integer", "default": 1 } }
        ],
        "responses": { "200": { "description": "Employee list", "content": { "application/json": { "schema": { "$ref": "#/components/schemas/Envelope" } } } } }
      }
    },
    "/api/hr/recruitment/jobs": {
      "get": {
        "tags": ["HR"],
        "summary": "List open job postings",
        "responses": { "200": { "description": "Job list", "content": { "application/json": { "schema": { "$ref": "#/components/schemas/Envelope" } } } } }
      },
      "post": {
        "tags": ["HR"],
        "summary": "Create job posting",
        "requestBody": {
          "required": true,
          "content": { "application/json": { "schema": {
            "type": "object",
            "required": ["title","department"],
            "properties": {
              "title": { "type": "string" },
              "department": { "type": "string" },
              "description": { "type": "string" },
              "closing_date": { "type": "string", "format": "date" }
            }
          }}}
        },
        "responses": { "201": { "description": "Job created" } }
      }
    },
    "/api/compliance/regulatory-calendar": {
      "get": {
        "tags": ["Compliance"],
        "summary": "Regulatory filing calendar",
        "parameters": [
          { "name": "status", "in": "query", "schema": { "type": "string", "enum": ["upcoming","overdue","done"] } }
        ],
        "responses": { "200": { "description": "Calendar entries", "content": { "application/json": { "schema": { "$ref": "#/components/schemas/Envelope" } } } } }
      }
    },
    "/api/compliance/kyc-expiry": {
      "get": {
        "tags": ["Compliance"],
        "summary": "Customers with KYC documents expiring soon",
        "parameters": [
          { "name": "horizon_days", "in": "query", "schema": { "type": "integer", "default": 30 } }
        ],
        "responses": { "200": { "description": "KYC expiry list", "content": { "application/json": { "schema": { "$ref": "#/components/schemas/Envelope" } } } } }
      }
    },
    "/api/bi/reports": {
      "get": {
        "tags": ["BI"],
        "summary": "List saved BI report definitions",
        "responses": { "200": { "description": "Report list", "content": { "application/json": { "schema": { "$ref": "#/components/schemas/Envelope" } } } } }
      },
      "post": {
        "tags": ["BI"],
        "summary": "Save a custom report definition",
        "requestBody": {
          "required": true,
          "content": { "application/json": { "schema": {
            "type": "object",
            "required": ["name","module"],
            "properties": {
              "name": { "type": "string" },
              "module": { "type": "string" },
              "dimensions": { "type": "array", "items": { "type": "string" } },
              "metrics": { "type": "array", "items": { "type": "string" } },
              "filters": { "type": "object" }
            }
          }}}
        },
        "responses": { "201": { "description": "Report saved" } }
      }
    },
    "/api/bi/reports/{id}/run": {
      "post": {
        "tags": ["BI"],
        "summary": "Execute a saved report and return paginated results",
        "parameters": [{ "name": "id", "in": "path", "required": true, "schema": { "type": "integer" } }],
        "responses": { "200": { "description": "Report results", "content": { "application/json": { "schema": { "$ref": "#/components/schemas/Envelope" } } } } }
      }
    },
    "/api/bi/reports/{id}/export": {
      "get": {
        "tags": ["BI"],
        "summary": "Download report as CSV (streaming)",
        "parameters": [{ "name": "id", "in": "path", "required": true, "schema": { "type": "integer" } }],
        "responses": {
          "200": { "description": "CSV file", "content": { "text/csv": { "schema": { "type": "string" } } } }
        }
      }
    },
    "/api/bi/reports/{id}/schedule": {
      "post": {
        "tags": ["BI"],
        "summary": "Schedule recurring report delivery",
        "parameters": [{ "name": "id", "in": "path", "required": true, "schema": { "type": "integer" } }],
        "requestBody": {
          "required": true,
          "content": { "application/json": { "schema": {
            "type": "object",
            "required": ["cron","recipients"],
            "properties": {
              "cron": { "type": "string", "example": "0 8 1 * *", "description": "Cron expression — e.g. 1st of every month at 08:00" },
              "recipients": { "type": "array", "items": { "type": "string", "format": "email" } },
              "format": { "type": "string", "enum": ["csv","html"], "default": "csv" }
            }
          }}}
        },
        "responses": { "201": { "description": "Schedule created" } }
      }
    },
    "/api/contact-lists/{id}/members/search": {
      "get": {
        "tags": ["Campaigns"],
        "summary": "Search contact list members by phone or email (uses HMAC blind index — plaintext is not stored in query)",
        "parameters": [
          { "name": "id", "in": "path", "required": true, "schema": { "type": "integer" } },
          { "name": "phone", "in": "query", "schema": { "type": "string" } },
          { "name": "email", "in": "query", "schema": { "type": "string" } }
        ],
        "responses": {
          "200": { "description": "Matching members", "content": { "application/json": { "schema": { "$ref": "#/components/schemas/Envelope" } } } },
          "400": { "description": "phone or email required" }
        }
      }
    },
    "/api/health": {
      "get": {
        "tags": ["System"],
        "summary": "Health check",
        "security": [],
        "responses": {
          "200": { "description": "Service healthy", "content": { "application/json": { "schema": {
            "type": "object",
            "properties": {
              "status": { "type": "string", "example": "ok" },
              "db": { "type": "string", "example": "ok" }
            }
          }}}}
        }
      }
    },
    "/metrics": {
      "get": {
        "tags": ["System"],
        "summary": "Prometheus metrics scrape endpoint",
        "security": [],
        "responses": { "200": { "description": "Prometheus text format metrics", "content": { "text/plain": {} } } }
      }
    }
  },
  "tags": [
    { "name": "Auth", "description": "Authentication, JWT tokens, TOTP MFA" },
    { "name": "Credit Applications", "description": "Loan and credit card origination (LOS)" },
    { "name": "Helpdesk", "description": "Ticket management, messaging, KB, CSAT" },
    { "name": "Collections", "description": "Collections queue, promises-to-pay, repayment plans" },
    { "name": "Finance", "description": "Finance overview, GL, manual postings, FD maturity" },
    { "name": "Sales", "description": "Sales targets, lead source attribution, pipeline" },
    { "name": "CRM", "description": "Contacts, deals, pipeline management" },
    { "name": "Admin", "description": "User management, roles, API keys, integration registry" },
    { "name": "HR", "description": "Employees, recruitment, onboarding, offboarding" },
    { "name": "Compliance", "description": "Regulatory calendar, KYC expiry, AML rules" },
    { "name": "BI", "description": "Report builder, scheduled reports, cross-module analytics" },
    { "name": "Campaigns", "description": "Email / SMS campaign management and contact lists" },
    { "name": "System", "description": "Health check and Prometheus metrics" }
  ]
}`
