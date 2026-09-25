"""Two-sided Student-t p-value, correct at the n these experiments actually use.

WHY THIS FILE EXISTS
`analyse-powered.py` computed its t p-value with a NORMAL approximation
(`erfc(|t|/sqrt2)`), carrying a comment that this was "honest enough at n=3 given
the sign test carries the verdict". It is not. At n=3 per arm, df=4, and:

    p=0.05 requires t=2.776  ->  the normal approximation reports p=0.0055

It overstates significance by about 9x at the only threshold anyone reads, and in
the direction that manufactures a result. A printed p-value gets read no matter
what the surrounding comment says — the same reason the power gate throws instead
of warning.

No scipy in this venv, so this is the regularised incomplete beta via the standard
Lentz continued fraction, the textbook route to the t CDF:

    P(|T| > t) = I_{df/(df+t^2)}(df/2, 1/2)

Run `python3 tdist.py` to check it against textbook critical values.
"""

from math import erfc, exp, inf, lgamma, log, sqrt

_TINY = 1e-300


def _betacf(a: float, b: float, x: float, itmax: int = 300, eps: float = 3e-16) -> float:
    """Continued fraction for the incomplete beta function (Lentz's method)."""
    qab, qap, qam = a + b, a + 1.0, a - 1.0
    c = 1.0
    d = 1.0 - qab * x / qap
    if abs(d) < _TINY:
        d = _TINY
    d = 1.0 / d
    h = d
    for m in range(1, itmax + 1):
        m2 = 2 * m
        aa = m * (b - m) * x / ((qam + m2) * (a + m2))
        d = 1.0 + aa * d
        if abs(d) < _TINY:
            d = _TINY
        c = 1.0 + aa / c
        if abs(c) < _TINY:
            c = _TINY
        d = 1.0 / d
        h *= d * c
        aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2))
        d = 1.0 + aa * d
        if abs(d) < _TINY:
            d = _TINY
        c = 1.0 + aa / c
        if abs(c) < _TINY:
            c = _TINY
        d = 1.0 / d
        delta = d * c
        h *= delta
        if abs(delta - 1.0) < eps:
            break
    return h


def betainc(a: float, b: float, x: float) -> float:
    """Regularised incomplete beta I_x(a, b)."""
    if x <= 0.0:
        return 0.0
    if x >= 1.0:
        return 1.0
    front = exp(lgamma(a + b) - lgamma(a) - lgamma(b) + a * log(x) + b * log(1.0 - x))
    if x < (a + 1.0) / (a + b + 2.0):
        return front * _betacf(a, b, x) / a
    return 1.0 - front * _betacf(b, a, 1.0 - x) / b


def t_sf_two_sided(t: float, df: float) -> float:
    """P(|T| > |t|) for Student's t with `df` degrees of freedom."""
    if df <= 0:
        return float("nan")
    t = abs(t)
    if t == 0.0:
        return 1.0
    if t == inf:
        return 0.0
    return betainc(df / 2.0, 0.5, df / (df + t * t))


if __name__ == "__main__":
    # Textbook two-sided critical values. If these drift, the implementation is wrong.
    CASES = [
        (2.776, 4, 0.050),
        (2.132, 4, 0.100),
        (4.604, 4, 0.010),
        (2.447, 6, 0.050),
        (2.228, 10, 0.050),
        (2.042, 30, 0.050),
        (1.960, 1000000, 0.050),  # the normal limit
    ]
    print(f"{'t':>8s} {'df':>9s} {'expected':>9s} {'got':>9s}  ok")
    ok = True
    for t, df, expect in CASES:
        got = t_sf_two_sided(t, df)
        good = abs(got - expect) < 0.002
        ok = ok and good
        print(f"{t:8.3f} {df:9d} {expect:9.3f} {got:9.4f}  {'PASS' if good else 'FAIL'}")
    print("\nwhat the normal approximation said, at the n these designs use:")
    for t, df, expect in CASES[:3]:
        approx = erfc(t / sqrt(2))
        print(f"  t={t:.3f} df={df}: true {expect:.4f}  normal {approx:.4f}"
              f"  overstated {expect / approx:.1f}x")
    raise SystemExit(0 if ok else 1)
