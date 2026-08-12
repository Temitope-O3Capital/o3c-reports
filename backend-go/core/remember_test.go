package core

import (
	"testing"
	"time"
)

// The whole feature turns on the remembered flag surviving a round trip. If it is lost
// anywhere — issuing, verifying, or rotating — the session silently reverts to 7 days
// and the user is logged out weeks earlier than the checkbox promised, with nothing in
// the UI to explain it.

func TestRefreshTokenTTL(t *testing.T) {
	if got := RefreshTokenTTL(false); got != 7*24*time.Hour {
		t.Errorf("default TTL = %v, want 7 days", got)
	}
	if got := RefreshTokenTTL(true); got != 30*24*time.Hour {
		t.Errorf("remembered TTL = %v, want 30 days", got)
	}
}

func TestRefreshTokenCarriesRememberFlag(t *testing.T) {
	secretKey = "test-secret-key-at-least-32-chars-long!!"

	for _, remember := range []bool{true, false} {
		tok, err := CreateRefreshTokenRemember(42, remember)
		if err != nil {
			t.Fatalf("CreateRefreshTokenRemember(%v): %v", remember, err)
		}
		claims, err := VerifyRefreshToken(tok)
		if err != nil {
			t.Fatalf("VerifyRefreshToken(%v): %v", remember, err)
		}
		if claims.Remember != remember {
			t.Errorf("remember round-trip: got %v, want %v", claims.Remember, remember)
		}
		if claims.ID != 42 {
			t.Errorf("user id: got %d, want 42", claims.ID)
		}

		// Expiry must match the TTL the flag selects, because the cookie MaxAge is
		// derived from the same function — if these diverge the browser keeps sending
		// a token the server already rejects.
		want := time.Now().Add(RefreshTokenTTL(remember))
		if diff := claims.ExpiresAt.Time.Sub(want); diff > time.Minute || diff < -time.Minute {
			t.Errorf("expiry off by %v for remember=%v", diff, remember)
		}
	}
}

// Rotation is where this is easiest to get wrong: refreshHandler mints a NEW token
// from the old one's claims, so a remembered session that rotates without the flag
// becomes a rolling 7-day session and "keep me signed in" quietly means nothing.
func TestRememberSurvivesRotation(t *testing.T) {
	secretKey = "test-secret-key-at-least-32-chars-long!!"

	tok, err := CreateRefreshTokenRemember(7, true)
	if err != nil {
		t.Fatalf("initial token: %v", err)
	}

	for i := 0; i < 5; i++ {
		old, err := VerifyRefreshToken(tok)
		if err != nil {
			t.Fatalf("rotation %d verify: %v", i, err)
		}
		if !old.Remember {
			t.Fatalf("remember lost at rotation %d", i)
		}
		// Mirrors refreshHandler.
		tok, err = CreateRefreshTokenRemember(old.ID, old.Remember)
		if err != nil {
			t.Fatalf("rotation %d reissue: %v", i, err)
		}
	}

	final, err := VerifyRefreshToken(tok)
	if err != nil {
		t.Fatalf("final verify: %v", err)
	}
	if !final.Remember {
		t.Error("remember flag lost after 5 rotations")
	}
	if final.ExpiresAt.Time.Before(time.Now().Add(29 * 24 * time.Hour)) {
		t.Error("rotated token expires too soon — TTL collapsed toward the default")
	}
}

// MFA users tick the box at the password step but do not receive a refresh token until
// the code is verified, so the preference has to ride along on the challenge token.
func TestMFATokenCarriesRemember(t *testing.T) {
	secretKey = "test-secret-key-at-least-32-chars-long!!"

	for _, remember := range []bool{true, false} {
		tok, err := CreateMFATokenRemember(9, remember)
		if err != nil {
			t.Fatalf("CreateMFATokenRemember(%v): %v", remember, err)
		}
		claims, err := VerifyMFATokenClaims(tok)
		if err != nil {
			t.Fatalf("VerifyMFATokenClaims(%v): %v", remember, err)
		}
		if claims.Remember != remember {
			t.Errorf("mfa remember: got %v, want %v", claims.Remember, remember)
		}
		if claims.ID != 9 {
			t.Errorf("mfa user id: got %d, want 9", claims.ID)
		}
	}
}

// Revocation hangs entirely on IssuedAt being set. tokenPredatesInvalidation returns
// false when it is nil, so a token minted without it can never be revoked by moving the
// tokens_valid_from watermark — which is what "sign out everywhere", a password change
// and the forgot-password reset all rely on. Both token types were missing it.
func TestTokensCarryIssuedAt(t *testing.T) {
	secretKey = "test-secret-key-at-least-32-chars-long!!"

	access, err := CreateToken(&Claims{ID: 3, Sub: "a@b.c", Role: "admin"})
	if err != nil {
		t.Fatalf("CreateToken: %v", err)
	}
	ac, err := VerifyToken(access)
	if err != nil {
		t.Fatalf("VerifyToken: %v", err)
	}
	if ac.IssuedAt == nil {
		t.Error("access token has no IssuedAt — it can never be revoked")
	}

	refresh, err := CreateRefreshTokenRemember(3, true)
	if err != nil {
		t.Fatalf("CreateRefreshTokenRemember: %v", err)
	}
	rc, err := VerifyRefreshToken(refresh)
	if err != nil {
		t.Fatalf("VerifyRefreshToken: %v", err)
	}
	if rc.IssuedAt == nil {
		t.Error("refresh token has no IssuedAt — a 30-day session that cannot be revoked")
	}
}

// A refresh token must never be usable as an access token. Adding a claim to the
// shared struct is exactly the kind of change that could blur that line.
func TestRefreshTokenRejectedAsAccessToken(t *testing.T) {
	secretKey = "test-secret-key-at-least-32-chars-long!!"

	tok, err := CreateRefreshTokenRemember(1, true)
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if _, err := VerifyToken(tok); err == nil {
		t.Error("refresh token was accepted as an access token")
	}
}
