package handlers

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/reports/core"
)

func RegisterHR(r chi.Router, db *core.DB) {
	read := core.RequirePages("hr_employees")
	mgr := core.RequirePages("hr_manager")

	// Employees
	r.With(read).Get("/employees", hrEmployeeList(db))
	r.With(read).Get("/employees/{id}", hrEmployeeGet(db))
	r.With(mgr).Post("/employees", hrEmployeeCreate(db))
	r.With(mgr).Put("/employees/{id}", hrEmployeeUpdate(db))
	r.With(read).Get("/employees/{id}/leave-balance", hrLeaveBalance(db))

	// Departments & grade levels
	r.With(read).Get("/departments", hrDepartments(db))
	r.With(read).Get("/grade-levels", hrGradeLevels(db))

	// Leave
	r.With(read).Get("/leave", hrLeaveList(db))
	r.With(read).Post("/leave", hrLeaveApply(db))
	r.With(mgr).Put("/leave/{id}/approve", hrLeaveApprove(db))
	r.With(mgr).Put("/leave/{id}/decline", hrLeaveDecline(db))
	r.With(read).Get("/leave-types", hrLeaveTypes(db))

	// Appraisals
	r.With(read).Get("/appraisals", hrAppraisalList(db))
	r.With(read).Get("/appraisals/{id}", hrAppraisalGet(db))
	r.With(mgr).Post("/review-cycles", hrReviewCycleCreate(db))
	r.With(read).Get("/review-cycles", hrReviewCycleList(db))

	// Disciplinary
	r.With(read).Get("/disciplinary", hrDisciplinaryList(db))
	r.With(read).Get("/disciplinary/{id}", hrDisciplinaryGet(db))
	r.With(mgr).Post("/disciplinary", hrDisciplinaryCreate(db))
	r.With(mgr).Put("/disciplinary/{id}/status", hrDisciplinaryStatus(db))

	// Training
	r.With(read).Get("/training", hrTrainingList(db))
	r.With(mgr).Post("/training", hrTrainingCreate(db))
	r.With(read).Put("/training/{id}/attend", hrTrainingAttend(db))

	// Dashboard
	r.With(read).Get("/dashboard", hrDashboard(db))
}

// ── Employees ─────────────────────────────────────────────────────────────────

func hrEmployeeList(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		status := qstr(r, "status")
		dept := qstr(r, "dept")
		q := qstr(r, "q")
		limit := qint(r, "limit", 50, 1, 200)
		offset := qint(r, "offset", 0, 0, 1<<30)

		query := `SELECT e.id, e.staff_id, e.first_name, e.last_name, e.email, e.phone,
		                 e.job_title, e.employment_type, e.employment_date, e.status,
		                 d.name AS department_name, g.name AS grade_level_name
		          FROM employees e
		          LEFT JOIN departments d ON e.department_id = d.id
		          LEFT JOIN grade_levels g ON e.grade_level_id = g.id
		          WHERE 1=1`
		args := []any{}
		n := 1

		if status != "" {
			query += fmt.Sprintf(" AND e.status = $%d", n)
			args = append(args, status)
			n++
		}
		if dept != "" {
			query += fmt.Sprintf(" AND d.name ILIKE $%d", n)
			args = append(args, "%"+dept+"%")
			n++
		}
		if q != "" {
			query += fmt.Sprintf(" AND (e.first_name ILIKE $%d OR e.last_name ILIKE $%d OR e.staff_id ILIKE $%d OR e.email ILIKE $%d)", n, n, n, n)
			args = append(args, "%"+q+"%")
			n++
		}
		query += fmt.Sprintf(" ORDER BY e.last_name, e.first_name LIMIT $%d OFFSET $%d", n, n+1)
		args = append(args, limit, offset)

		rows, err := db.PGQuery(r.Context(), query, args...)
		if err != nil {
			respondErr(w, 500, "Query failed")
			return
		}
		if rows == nil {
			rows = []core.Row{}
		}
		respond(w, rows, "pg")
	}
}

func hrEmployeeGet(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
		if err != nil {
			respondErr(w, 400, "Invalid employee ID")
			return
		}
		rows, err := db.PGQuery(r.Context(), `
			SELECT e.*, d.name AS department_name, g.name AS grade_level_name
			FROM employees e
			LEFT JOIN departments d ON e.department_id = d.id
			LEFT JOIN grade_levels g ON e.grade_level_id = g.id
			WHERE e.id = $1`, id)
		if err != nil || len(rows) == 0 {
			respondErr(w, 404, "Employee not found")
			return
		}
		respond(w, rows[0], "pg")
	}
}

func hrEmployeeCreate(db *core.DB) http.HandlerFunc {
	type body struct {
		StaffID        string  `json:"staff_id"`
		FirstName      string  `json:"first_name"`
		LastName       string  `json:"last_name"`
		MiddleName     string  `json:"middle_name"`
		Email          string  `json:"email"`
		Phone          string  `json:"phone"`
		DepartmentID   int     `json:"department_id"`
		GradeLevelID   int     `json:"grade_level_id"`
		JobTitle       string  `json:"job_title"`
		EmploymentType string  `json:"employment_type"`
		EmploymentDate string  `json:"employment_date"`
		SalaryKobo     int64   `json:"salary_kobo"`
		BankName       string  `json:"bank_name"`
		AccountNumber  string  `json:"account_number"`
		UserID         *int64  `json:"user_id"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		if b.FirstName == "" || b.LastName == "" || b.Email == "" {
			respondErr(w, 422, "first_name, last_name, and email are required")
			return
		}
		rows, err := db.PGQuery(r.Context(), `
			INSERT INTO employees (staff_id, user_id, first_name, last_name, middle_name,
				email, phone, department_id, grade_level_id, job_title, employment_type,
				employment_date, salary_kobo, bank_name, account_number, status, created_at, updated_at)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'active',NOW(),NOW())
			RETURNING id, staff_id, first_name, last_name, email, status`,
			b.StaffID, b.UserID, b.FirstName, b.LastName, b.MiddleName,
			b.Email, b.Phone, b.DepartmentID, b.GradeLevelID, b.JobTitle, b.EmploymentType,
			b.EmploymentDate, b.SalaryKobo, b.BankName, b.AccountNumber)
		if err != nil {
			respondErr(w, 500, "Create failed")
			return
		}
		respond(w, rows[0], "pg")
	}
}

func hrEmployeeUpdate(db *core.DB) http.HandlerFunc {
	type body struct {
		JobTitle       string `json:"job_title"`
		DepartmentID   int    `json:"department_id"`
		GradeLevelID   int    `json:"grade_level_id"`
		SalaryKobo     int64  `json:"salary_kobo"`
		Status         string `json:"status"`
		ConfirmationDate string `json:"confirmation_date"`
		ExitDate       string `json:"exit_date"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
		if err != nil {
			respondErr(w, 400, "Invalid employee ID")
			return
		}
		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		_, err = db.PGExec(r.Context(), `
			UPDATE employees SET
				job_title = COALESCE(NULLIF($1,''), job_title),
				department_id = CASE WHEN $2 > 0 THEN $2 ELSE department_id END,
				grade_level_id = CASE WHEN $3 > 0 THEN $3 ELSE grade_level_id END,
				salary_kobo = CASE WHEN $4 > 0 THEN $4 ELSE salary_kobo END,
				status = COALESCE(NULLIF($5,''), status),
				confirmation_date = COALESCE(NULLIF($6,'')::date, confirmation_date),
				exit_date = COALESCE(NULLIF($7,'')::date, exit_date),
				updated_at = NOW()
			WHERE id = $8`,
			b.JobTitle, b.DepartmentID, b.GradeLevelID, b.SalaryKobo,
			b.Status, b.ConfirmationDate, b.ExitDate, id)
		if err != nil {
			respondErr(w, 500, "Update failed")
			return
		}
		respondErr(w, 200, "Updated successfully")
	}
}

func hrLeaveBalance(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
		if err != nil {
			respondErr(w, 400, "Invalid employee ID")
			return
		}
		rows, err := db.PGQuery(r.Context(), `
			SELECT lb.*, lt.name AS leave_type_name, lt.is_paid
			FROM leave_balances lb
			JOIN leave_types lt ON lb.leave_type_id = lt.id
			WHERE lb.employee_id = $1 AND lb.year = EXTRACT(YEAR FROM CURRENT_DATE)
			ORDER BY lt.name`, id)
		if err != nil {
			respondErr(w, 500, "Query failed")
			return
		}
		if rows == nil {
			rows = []core.Row{}
		}
		respond(w, rows, "pg")
	}
}

// ── Departments & Grade Levels ─────────────────────────────────────────────────

func hrDepartments(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rows, err := db.PGQuery(r.Context(),
			`SELECT * FROM departments ORDER BY name`)
		if err != nil {
			respondErr(w, 500, "Query failed")
			return
		}
		if rows == nil {
			rows = []core.Row{}
		}
		respond(w, rows, "pg")
	}
}

func hrGradeLevels(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rows, err := db.PGQuery(r.Context(),
			`SELECT * FROM grade_levels ORDER BY level_number`)
		if err != nil {
			respondErr(w, 500, "Query failed")
			return
		}
		if rows == nil {
			rows = []core.Row{}
		}
		respond(w, rows, "pg")
	}
}

// ── Leave ─────────────────────────────────────────────────────────────────────

func hrLeaveList(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		status := qstr(r, "status")
		empID := qstr(r, "employee_id")
		limit := qint(r, "limit", 50, 1, 200)
		offset := qint(r, "offset", 0, 0, 1<<30)

		query := `SELECT la.*, lt.name AS leave_type_name,
		                 e.first_name, e.last_name, e.staff_id
		          FROM leave_applications la
		          JOIN leave_types lt ON la.leave_type_id = lt.id
		          JOIN employees e ON la.employee_id = e.id
		          WHERE 1=1`
		args := []any{}
		n := 1

		if status != "" {
			query += fmt.Sprintf(" AND la.status = $%d", n)
			args = append(args, status)
			n++
		}
		if empID != "" {
			query += fmt.Sprintf(" AND la.employee_id = $%d", n)
			args = append(args, empID)
			n++
		}
		query += fmt.Sprintf(" ORDER BY la.created_at DESC LIMIT $%d OFFSET $%d", n, n+1)
		args = append(args, limit, offset)

		rows, err := db.PGQuery(r.Context(), query, args...)
		if err != nil {
			respondErr(w, 500, "Query failed")
			return
		}
		if rows == nil {
			rows = []core.Row{}
		}
		respond(w, rows, "pg")
	}
}

func hrLeaveApply(db *core.DB) http.HandlerFunc {
	type body struct {
		EmployeeID    int64  `json:"employee_id"`
		LeaveTypeID   int    `json:"leave_type_id"`
		StartDate     string `json:"start_date"`
		EndDate       string `json:"end_date"`
		DaysRequested int    `json:"days_requested"`
		Reason        string `json:"reason"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		if b.EmployeeID == 0 || b.LeaveTypeID == 0 || b.StartDate == "" || b.EndDate == "" {
			respondErr(w, 422, "employee_id, leave_type_id, start_date, end_date are required")
			return
		}
		rows, err := db.PGQuery(r.Context(), `
			INSERT INTO leave_applications (employee_id, leave_type_id, start_date, end_date,
				days_requested, reason, status, created_at, updated_at)
			VALUES ($1,$2,$3,$4,$5,$6,'pending',NOW(),NOW())
			RETURNING id, status, start_date, end_date`,
			b.EmployeeID, b.LeaveTypeID, b.StartDate, b.EndDate, b.DaysRequested, b.Reason)
		if err != nil {
			respondErr(w, 500, "Apply failed")
			return
		}
		respond(w, rows[0], "pg")
	}
}

func hrLeaveApprove(db *core.DB) http.HandlerFunc {
	type body struct {
		Notes string `json:"notes"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
		if err != nil {
			respondErr(w, 400, "Invalid leave ID")
			return
		}
		var b body
		json.NewDecoder(r.Body).Decode(&b) //nolint:errcheck
		user := core.UserFromCtx(r.Context())

		_, err = db.PGExec(r.Context(), `
			UPDATE leave_applications SET status = 'approved',
				approved_by = $1, approval_notes = $2, updated_at = NOW()
			WHERE id = $3`, user.ID, b.Notes, id)
		if err != nil {
			respondErr(w, 500, "Approve failed")
			return
		}
		respondErr(w, 200, "Leave approved")
	}
}

func hrLeaveDecline(db *core.DB) http.HandlerFunc {
	type body struct {
		Notes string `json:"notes"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
		if err != nil {
			respondErr(w, 400, "Invalid leave ID")
			return
		}
		var b body
		json.NewDecoder(r.Body).Decode(&b) //nolint:errcheck
		user := core.UserFromCtx(r.Context())

		_, err = db.PGExec(r.Context(), `
			UPDATE leave_applications SET status = 'declined',
				approved_by = $1, approval_notes = $2, updated_at = NOW()
			WHERE id = $3`, user.ID, b.Notes, id)
		if err != nil {
			respondErr(w, 500, "Decline failed")
			return
		}
		respondErr(w, 200, "Leave declined")
	}
}

func hrLeaveTypes(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rows, err := db.PGQuery(r.Context(), `SELECT * FROM leave_types ORDER BY name`)
		if err != nil {
			respondErr(w, 500, "Query failed")
			return
		}
		if rows == nil {
			rows = []core.Row{}
		}
		respond(w, rows, "pg")
	}
}

// ── Appraisals ────────────────────────────────────────────────────────────────

func hrAppraisalList(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		cycleID := qstr(r, "cycle_id")
		empID := qstr(r, "employee_id")
		status := qstr(r, "status")

		query := `SELECT a.*, rc.name AS cycle_name,
		                 e.first_name, e.last_name, e.staff_id
		          FROM appraisals a
		          JOIN review_cycles rc ON a.cycle_id = rc.id
		          JOIN employees e ON a.employee_id = e.id
		          WHERE 1=1`
		args := []any{}
		n := 1

		if cycleID != "" {
			query += fmt.Sprintf(" AND a.cycle_id = $%d", n)
			args = append(args, cycleID)
			n++
		}
		if empID != "" {
			query += fmt.Sprintf(" AND a.employee_id = $%d", n)
			args = append(args, empID)
			n++
		}
		if status != "" {
			query += fmt.Sprintf(" AND a.status = $%d", n)
			args = append(args, status)
			n++
		}
		query += " ORDER BY a.created_at DESC"

		rows, err := db.PGQuery(r.Context(), query, args...)
		if err != nil {
			respondErr(w, 500, "Query failed")
			return
		}
		if rows == nil {
			rows = []core.Row{}
		}
		respond(w, rows, "pg")
	}
}

func hrAppraisalGet(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
		if err != nil {
			respondErr(w, 400, "Invalid appraisal ID")
			return
		}
		ctx := r.Context()

		apps, err := db.PGQuery(ctx, `
			SELECT a.*, rc.name AS cycle_name, e.first_name, e.last_name, e.staff_id
			FROM appraisals a
			JOIN review_cycles rc ON a.cycle_id = rc.id
			JOIN employees e ON a.employee_id = e.id
			WHERE a.id = $1`, id)
		if err != nil || len(apps) == 0 {
			respondErr(w, 404, "Appraisal not found")
			return
		}

		items, _ := db.PGQuery(ctx, `SELECT * FROM appraisal_items WHERE appraisal_id = $1 ORDER BY id`, id)
		if items == nil {
			items = []core.Row{}
		}

		respond(w, map[string]any{"appraisal": apps[0], "items": items}, "pg")
	}
}

func hrReviewCycleCreate(db *core.DB) http.HandlerFunc {
	type body struct {
		Name      string `json:"name"`
		StartDate string `json:"start_date"`
		EndDate   string `json:"end_date"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		if b.Name == "" || b.StartDate == "" || b.EndDate == "" {
			respondErr(w, 422, "name, start_date, end_date are required")
			return
		}
		rows, err := db.PGQuery(r.Context(), `
			INSERT INTO review_cycles (name, start_date, end_date, status, created_at)
			VALUES ($1, $2, $3, 'open', NOW())
			RETURNING id, name, start_date, end_date, status`,
			b.Name, b.StartDate, b.EndDate)
		if err != nil {
			respondErr(w, 500, "Create failed")
			return
		}
		respond(w, rows[0], "pg")
	}
}

func hrReviewCycleList(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rows, err := db.PGQuery(r.Context(),
			`SELECT * FROM review_cycles ORDER BY start_date DESC`)
		if err != nil {
			respondErr(w, 500, "Query failed")
			return
		}
		if rows == nil {
			rows = []core.Row{}
		}
		respond(w, rows, "pg")
	}
}

// ── Disciplinary ──────────────────────────────────────────────────────────────

func hrDisciplinaryList(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		status := qstr(r, "status")
		empID := qstr(r, "employee_id")

		query := `SELECT dc.*, e.first_name, e.last_name, e.staff_id
		          FROM disciplinary_cases dc
		          JOIN employees e ON dc.employee_id = e.id
		          WHERE 1=1`
		args := []any{}
		n := 1

		if status != "" {
			query += fmt.Sprintf(" AND dc.status = $%d", n)
			args = append(args, status)
			n++
		}
		if empID != "" {
			query += fmt.Sprintf(" AND dc.employee_id = $%d", n)
			args = append(args, empID)
			n++
		}
		query += " ORDER BY dc.created_at DESC"

		rows, err := db.PGQuery(r.Context(), query, args...)
		if err != nil {
			respondErr(w, 500, "Query failed")
			return
		}
		if rows == nil {
			rows = []core.Row{}
		}
		respond(w, rows, "pg")
	}
}

func hrDisciplinaryGet(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
		if err != nil {
			respondErr(w, 400, "Invalid case ID")
			return
		}
		ctx := r.Context()

		cases, err := db.PGQuery(ctx, `
			SELECT dc.*, e.first_name, e.last_name, e.staff_id
			FROM disciplinary_cases dc
			JOIN employees e ON dc.employee_id = e.id
			WHERE dc.id = $1`, id)
		if err != nil || len(cases) == 0 {
			respondErr(w, 404, "Case not found")
			return
		}

		hearings, _ := db.PGQuery(ctx, `SELECT * FROM disciplinary_hearings WHERE case_id = $1 ORDER BY scheduled_at`, id)
		actions, _ := db.PGQuery(ctx, `SELECT * FROM disciplinary_actions WHERE case_id = $1 ORDER BY effective_date`, id)

		if hearings == nil {
			hearings = []core.Row{}
		}
		if actions == nil {
			actions = []core.Row{}
		}

		respond(w, map[string]any{"case": cases[0], "hearings": hearings, "actions": actions}, "pg")
	}
}

func hrDisciplinaryCreate(db *core.DB) http.HandlerFunc {
	type body struct {
		EmployeeID  int64  `json:"employee_id"`
		OffenseType string `json:"offense_type"`
		Description string `json:"description"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		if b.EmployeeID == 0 || b.OffenseType == "" {
			respondErr(w, 422, "employee_id and offense_type are required")
			return
		}
		user := core.UserFromCtx(r.Context())
		rows, err := db.PGQuery(r.Context(), `
			INSERT INTO disciplinary_cases (employee_id, initiated_by, offense_type, description, status, created_at, updated_at)
			VALUES ($1, $2, $3, $4, 'open', NOW(), NOW())
			RETURNING id, status, offense_type, created_at`,
			b.EmployeeID, user.ID, b.OffenseType, b.Description)
		if err != nil {
			respondErr(w, 500, "Create failed")
			return
		}
		respond(w, rows[0], "pg")
	}
}

func hrDisciplinaryStatus(db *core.DB) http.HandlerFunc {
	type body struct {
		Status string `json:"status"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
		if err != nil {
			respondErr(w, 400, "Invalid case ID")
			return
		}
		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		if b.Status == "" {
			respondErr(w, 422, "status is required")
			return
		}
		_, err = db.PGExec(r.Context(),
			`UPDATE disciplinary_cases SET status = $1, updated_at = NOW() WHERE id = $2`,
			b.Status, id)
		if err != nil {
			respondErr(w, 500, "Update failed")
			return
		}
		respondErr(w, 200, "Status updated")
	}
}

// ── Training ──────────────────────────────────────────────────────────────────

func hrTrainingList(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		status := qstr(r, "status")

		query := `SELECT * FROM training_sessions WHERE 1=1`
		args := []any{}
		if status != "" {
			query += " AND status = $1"
			args = append(args, status)
		}
		query += " ORDER BY start_date DESC"

		rows, err := db.PGQuery(r.Context(), query, args...)
		if err != nil {
			respondErr(w, 500, "Query failed")
			return
		}
		if rows == nil {
			rows = []core.Row{}
		}
		respond(w, rows, "pg")
	}
}

func hrTrainingCreate(db *core.DB) http.HandlerFunc {
	type body struct {
		Title        string `json:"title"`
		Facilitator  string `json:"facilitator"`
		StartDate    string `json:"start_date"`
		EndDate      string `json:"end_date"`
		Venue        string `json:"venue"`
		MaxAttendees int    `json:"max_attendees"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		if b.Title == "" || b.StartDate == "" {
			respondErr(w, 422, "title and start_date are required")
			return
		}
		rows, err := db.PGQuery(r.Context(), `
			INSERT INTO training_sessions (title, facilitator, start_date, end_date, venue, status, max_attendees, created_at)
			VALUES ($1, $2, $3, $4, $5, 'scheduled', $6, NOW())
			RETURNING id, title, start_date, status`,
			b.Title, b.Facilitator, b.StartDate, b.EndDate, b.Venue, b.MaxAttendees)
		if err != nil {
			respondErr(w, 500, "Create failed")
			return
		}
		respond(w, rows[0], "pg")
	}
}

func hrTrainingAttend(db *core.DB) http.HandlerFunc {
	type body struct {
		EmployeeID        int64 `json:"employee_id"`
		Attended          bool  `json:"attended"`
		CertificateIssued bool  `json:"certificate_issued"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		sessionID, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
		if err != nil {
			respondErr(w, 400, "Invalid session ID")
			return
		}
		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		if b.EmployeeID == 0 {
			respondErr(w, 422, "employee_id is required")
			return
		}
		_, err = db.PGExec(r.Context(), `
			INSERT INTO training_attendance (session_id, employee_id, attended, certificate_issued, created_at)
			VALUES ($1, $2, $3, $4, NOW())
			ON CONFLICT (session_id, employee_id) DO UPDATE
				SET attended = EXCLUDED.attended, certificate_issued = EXCLUDED.certificate_issued`,
			sessionID, b.EmployeeID, b.Attended, b.CertificateIssued)
		if err != nil {
			respondErr(w, 500, "Record failed")
			return
		}
		respondErr(w, 200, "Attendance recorded")
	}
}

// ── Dashboard ─────────────────────────────────────────────────────────────────

func hrDashboard(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		dashboard := map[string]any{}

		// Headcount by department
		deptRows, _ := db.PGQuery(ctx, `
			SELECT d.name AS department, COUNT(e.id) AS headcount
			FROM employees e
			JOIN departments d ON e.department_id = d.id
			WHERE e.status = 'active'
			GROUP BY d.name ORDER BY headcount DESC`)
		if deptRows == nil {
			deptRows = []core.Row{}
		}
		dashboard["headcount_by_dept"] = deptRows

		// Pending leave count
		leaveRows, _ := db.PGQuery(ctx,
			`SELECT COUNT(*) AS count FROM leave_applications WHERE status = 'pending'`)
		if len(leaveRows) > 0 {
			dashboard["pending_leave_count"] = leaveRows[0]["count"]
		}

		// Active disciplinary cases
		discRows, _ := db.PGQuery(ctx,
			`SELECT COUNT(*) AS count FROM disciplinary_cases WHERE status = 'open'`)
		if len(discRows) > 0 {
			dashboard["active_disciplinary_count"] = discRows[0]["count"]
		}

		// Upcoming training (next 30 days)
		trainRows, _ := db.PGQuery(ctx, `
			SELECT id, title, start_date, venue, max_attendees
			FROM training_sessions
			WHERE status = 'scheduled'
			  AND start_date BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '30 days'
			ORDER BY start_date`)
		if trainRows == nil {
			trainRows = []core.Row{}
		}
		dashboard["upcoming_training"] = trainRows

		respond(w, dashboard, "pg")
	}
}
