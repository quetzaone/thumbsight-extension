Sources for the README images. Text stays as `<text>` here and gets converted to outlines, because GitHub shows README SVGs as plain images and won't load web fonts in them.

```sh
python -m pip install --target .pylib uharfbuzz fonttools
PYTHONPATH=.pylib python outline_text.py <fonts-dir> hero.src.svg ../hero.svg
PYTHONPATH=.pylib python outline_text.py <fonts-dir> how-it-works.src.svg ../how-it-works.svg
```

`<fonts-dir>` needs `InstrumentSans.ttf` and `GeistMono.ttf` from [google/fonts](https://github.com/google/fonts) (OFL).
