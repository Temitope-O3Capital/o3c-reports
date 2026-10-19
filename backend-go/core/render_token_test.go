package core

import (
	"testing"
	"time"
)

func init() { InitAuth("test-secret-for-render-token-tests") }

// A render token has to be an ordinary token, or AuthMiddleware would need a second
// verification path — which is the thing this design is avoiding.
func TestARenderTokenVerifiesLikeAnyOtherToken(t *testing.T) {
	in := &Claims{Sub: "u1", ID: 42, Role: "cards_head", FullName: "A Person",
		Department: "Cards", Pages: []string{"report_builder", "cards"}}

	raw, jti, exp, err := CreateRenderToken(in)
	if err != nil {
		t.Fatalf("minting: %v", err)
	}
	got, err := VerifyToken(raw)
	if err != nil {
		t.Fatalf("a render token must verify through the normal path: %v", err)
	}
	if got.ID != 42 || got.Role != "cards_head" {
		t.Errorf("claims not carried: id=%d role=%q", got.ID, got.Role)
	}
	// The PDF must not be able to show more than the requester could, so the pages have
	// to come across unchanged.
	if len(got.Pages) != 2 || got.Pages[0] != "report_builder" {
		t.Errorf("pages not carried: %v", got.Pages)
	}
	if got.JTI != jti {
		t.Errorf("JTI in the token (%q) is not the one returned for revoking (%q)", got.JTI, jti)
	}
	if jti == "" {
		t.Error("no JTI, so the token could never be revoked after the render")
	}
	if exp.IsZero() {
		t.Error("no expiry returned, so RevokeToken cannot be given one")
	}
}

// Two minutes, not thirty. This is the property that makes a leaked render URL close to
// worthless, so it is asserted rather than left to the constant.
func TestARenderTokenExpiresInMinutes(t *testing.T) {
	raw, _, exp, err := CreateRenderToken(&Claims{ID: 1, Role: "admin"})
	if err != nil {
		t.Fatalf("minting: %v", err)
	}
	life := time.Until(exp)
	if life > 5*time.Minute {
		t.Errorf("a render token lives %v; it is handed to a spawned process and should "+
			"expire in minutes, not in a session's worth of time", life)
	}
	if life <= 0 {
		t.Fatal("a render token that has already expired cannot render anything")
	}
	c, err := VerifyToken(raw)
	if err != nil {
		t.Fatalf("verify: %v", err)
	}
	if c.ExpiresAt == nil {
		t.Fatal("no exp claim, so the token would never expire on its own")
	}
	if c.ExpiresAt.Time.After(time.Now().Add(5 * time.Minute)) {
		t.Error("the exp CLAIM is longer than the returned expiry; the two must agree or " +
			"revocation is scheduled for the wrong time")
	}
	// IssuedAt must be set or tokenPredatesInvalidation treats the token as un-revokable
	// by a password change — the trap already documented on CreateToken.
	if c.IssuedAt == nil {
		t.Error("no iat claim: a password change would not invalidate this token")
	}
}

// The caller's Claims comes out of the request context and is shared with everything
// else serving that request. Writing a new JTI into it would reassign the live session's
// identity, so the mint must copy.
func TestMintingDoesNotMutateTheCallersClaims(t *testing.T) {
	in := &Claims{ID: 7, Role: "bi", JTI: "the-live-session-jti", Remember: true}
	if _, _, _, err := CreateRenderToken(in); err != nil {
		t.Fatalf("minting: %v", err)
	}
	if in.JTI != "the-live-session-jti" {
		t.Errorf("the caller's JTI was overwritten with %q: their live session now has the "+
			"render token's identity", in.JTI)
	}
	if !in.Remember {
		t.Error("the caller's Remember flag was cleared, which would collapse a 30-day session")
	}
}

func TestEveryRenderTokenGetsItsOwnJTI(t *testing.T) {
	_, a, _, err := CreateRenderToken(&Claims{ID: 1, Role: "admin"})
	if err != nil {
		t.Fatal(err)
	}
	_, b, _, err := CreateRenderToken(&Claims{ID: 1, Role: "admin"})
	if err != nil {
		t.Fatal(err)
	}
	if a == b {
		t.Error("two renders share a JTI, so revoking one would revoke the other")
	}
}

func TestMintingRefusesWithoutClaims(t *testing.T) {
	if _, _, _, err := CreateRenderToken(nil); err == nil {
		t.Error("minting a render token for nobody must fail: it would otherwise be a " +
			"credential with no user and no pages behind it")
	}
}
