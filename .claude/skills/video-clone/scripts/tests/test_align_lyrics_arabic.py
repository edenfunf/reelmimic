"""align_lyrics.norm_chars must give user lyrics and ASR output the same Arabic skeleton."""
import importlib.util
from pathlib import Path

_p = Path(__file__).resolve().parents[1] / "align_lyrics.py"
_spec = importlib.util.spec_from_file_location("align_lyrics", _p)
al = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(al)


def n(s):
    return "".join(al.norm_chars(s))


def test_tashkeel_is_dropped():
    assert n("وَالفَجْرِ") == n("والفجر")


def test_alef_variants_fold():
    assert n("أمل إلى آمن") == n("امل الى امن")


def test_ya_and_ta_marbuta_fold():
    assert n("مدرسة على") == n("مدرسه علي")


def test_tatweel_is_dropped():
    assert n("الحيـــاة") == n("الحياه")


def test_latin_and_cjk_unchanged():
    assert n("Hello, World") == "helloworld"
    assert len(al.norm_chars("你好，世界")) == 4


def test_mixed_line_keeps_latin():
    assert n("أحب AI") == n("احب ai")
