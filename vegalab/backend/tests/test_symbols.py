"""OCC ↔ tuple ↔ pretty round-trips, SPX and SPXW roots, error cases."""

from datetime import date

import pytest

from vegalab.symbols import OptionSymbol, format_occ, parse_occ, parse_pretty


class TestParseOcc:
    def test_spx_monthly_call(self):
        sym = parse_occ("SPX260620C05850000")
        assert sym == OptionSymbol(root="SPX", expiry=date(2026, 6, 20), right="C", strike=5850.0)

    def test_spxw_weekly_put(self):
        sym = parse_occ("SPXW260619P05900000")
        assert sym.root == "SPXW"
        assert sym.expiry == date(2026, 6, 19)
        assert sym.right == "P"
        assert sym.strike == 5900.0

    def test_fractional_strike(self):
        assert parse_occ("SPX260620C05847500").strike == 5847.5

    def test_lowercase_input_normalised(self):
        assert parse_occ("spxw260619p05900000").root == "SPXW"

    @pytest.mark.parametrize(
        "bad",
        [
            "",
            "SPX",
            "SPX260620X05850000",   # bad right
            "SPX26062C05850000",    # short date
            "SPX260620C0585000",    # 7-digit strike
            "260620C05850000",      # no root
            "TOOLONGROOT260620C05850000",
        ],
    )
    def test_rejects_garbage(self, bad):
        with pytest.raises(ValueError):
            parse_occ(bad)


class TestRoundTrips:
    @pytest.mark.parametrize("root", ["SPX", "SPXW"])
    @pytest.mark.parametrize("right", ["C", "P"])
    @pytest.mark.parametrize("strike", [100.0, 5847.5, 6000.0, 9999.875])
    def test_occ_roundtrip(self, root, right, strike):
        occ = format_occ(root, date(2026, 6, 19), right, strike)
        sym = parse_occ(occ)
        assert (sym.root, sym.expiry, sym.right, sym.strike) == (
            root, date(2026, 6, 19), right, strike,
        )
        assert sym.occ == occ

    def test_pretty_roundtrip(self):
        sym = OptionSymbol(root="SPXW", expiry=date(2026, 6, 19), right="P", strike=5900.0)
        assert sym.pretty == "SPXW 19JUN26 5900P"
        assert parse_pretty(sym.pretty) == sym

    def test_pretty_fractional_strike_roundtrip(self):
        sym = OptionSymbol(root="SPX", expiry=date(2026, 7, 17), right="C", strike=5847.5)
        assert parse_pretty(sym.pretty) == sym


class TestFormatOcc:
    def test_known_string(self):
        assert format_occ("SPX", date(2026, 6, 20), "C", 5850) == "SPX260620C05850000"

    def test_bad_right_rejected(self):
        with pytest.raises(ValueError):
            format_occ("SPX", date(2026, 6, 20), "X", 5850)

    def test_negative_strike_rejected(self):
        with pytest.raises(ValueError):
            format_occ("SPX", date(2026, 6, 20), "C", -5.0)
