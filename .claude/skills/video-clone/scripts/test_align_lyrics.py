"""Run with: python -m unittest discover -s .claude/skills/video-clone/scripts -p "test_*.py"  """
import unittest

from align_lyrics import read_lyric_lines


class ReadLyricLinesTest(unittest.TestCase):
    def test_plain_text_lines_are_kept_as_they_are(self):
        self.assertEqual(read_lyric_lines("第一句\n\n  第二句  \n"), ["第一句", "第二句"])

    def test_lrc_timestamps_are_removed_and_lines_kept(self):
        lrc = "[ti:Song]\n[00:01.00]第一句歌詞\n[00:05.00]第二句歌詞\n"
        self.assertEqual(read_lyric_lines(lrc), ["第一句歌詞", "第二句歌詞"])

    def test_section_tags_are_dropped(self):
        self.assertEqual(read_lyric_lines("[Chorus]\nhello\n[ar:Someone]"), ["hello"])

    def test_one_line_with_several_timestamps_is_kept_once(self):
        self.assertEqual(read_lyric_lines("[00:30.00][01:10.50]the chorus"), ["the chorus"])

    def test_enhanced_lrc_word_timestamps_are_removed(self):
        self.assertEqual(read_lyric_lines("[00:02.00]<00:02.00>hello <00:02.50>world"), ["hello world"])

    def test_timestamp_only_line_is_dropped(self):
        self.assertEqual(read_lyric_lines("[00:01.00]\n[00:02.00]real line"), ["real line"])

    def test_brackets_inside_a_lyric_line_are_kept(self):
        self.assertEqual(read_lyric_lines("[00:01.00]say [yes] now"), ["say [yes] now"])


if __name__ == "__main__":
    unittest.main()
