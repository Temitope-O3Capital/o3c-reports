package core

import (
	"time"

	"github.com/golang-jwt/jwt/v5"
)

// Tokens for server-side rendering: the credential a headless browser uses to open one
// page as the person who asked for it.
//
// THE DESIGN DECISION HERE IS THAT THERE IS NO NEW KIND OF CREDENTIAL. A render token is
// an ordinary access token with the ordinary audience, so AuthMiddleware verifies it
// through exactly the path every other request takes — same signature check, same
// denylist, same tokens_valid_from watermark. A second way to authenticate would be a
// second thing to get wrong, and this one would be held by a process spawned by the
// server rather than by a person.
//
// What makes it safe is not a special verification path, it is that it carries no extra
// power and almost no time:
//
//   - IT IS THE REQUESTER'S OWN CLAIMS. Same id, role, extra roles and pages. So a
//     rendered PDF can never contain anything the person asking could not have opened on
//     screen themselves, and every per-tile access check still runs against them.
//   - IT LIVES TWO MINUTES. Long enough for a browser to load a dashboard and draw its
//     charts, far too short to be useful to anyone who finds it later.
//   - IT IS REVOKED AS SOON AS THE RENDER FINISHES, by its JTI, through the denylist that
//     already exists. The caller gets the JTI back for exactly that purpose, and should
//     revoke it in a defer rather than on the happy path — a render that fails halfway is
//     the case where a live token is most likely to be left lying around.
//
// The TTL is a constant rather than a parameter on purpose: a caller that could ask for
// an hour eventually would.
const renderTokenExpiry = 2 * time.Minute

// CreateRenderToken issues a short-lived token for rendering, and returns it with its
// JTI so the caller can revoke it the moment the render is done.
//
// It copies the claims it is given rather than mutating them, because the caller's
// Claims came out of the request context and is shared with everything else handling
// that request — writing a new JTI into it would reassign the live session's identity.
func CreateRenderToken(in *Claims) (token string, jti string, expires time.Time, err error) {
	if in == nil {
		return "", "", time.Time{}, jwt.ErrTokenRequiredClaimMissing
	}
	c := *in
	c.Remember = false // a render is never a "keep me signed in" session
	c.JTI = newJTI()
	exp := time.Now().Add(renderTokenExpiry)
	c.RegisteredClaims = jwt.RegisteredClaims{
		ExpiresAt: jwt.NewNumericDate(exp),
		IssuedAt:  jwt.NewNumericDate(time.Now()),
		Audience:  jwt.ClaimStrings{tokenAudience},
		ID:        c.JTI,
	}
	signed, err := jwt.NewWithClaims(jwt.SigningMethodHS256, &c).SignedString([]byte(secretKey))
	if err != nil {
		return "", "", time.Time{}, err
	}
	return signed, c.JTI, exp, nil
}
