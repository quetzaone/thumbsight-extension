# Third-party notices — Thumb Sight public extension

Этот файл перечисляет **чужие материалы** внутри расширения и содержит полные
тексты применимых к ним лицензий — так, как того требуют сами лицензии
(«copyright notice and this permission notice appear in all copies»).

**Это не лицензия продукта.** Тексты ISC и MIT ниже относятся **только** к
перечисленным иконкам. Собственный код Thumb Sight ими не покрыт: собственный
код распространяется по лицензии MIT (файл `LICENSE`).

## 1. Встроенные SVG-иконки интерфейса

Отдельных файлов у них нет: контуры вставлены прямо в разметку. Всего восемь
inline-`<svg>` — пять в `popup.html`, три в `panel.html`.

Состав определён сверкой геометрии контуров с upstream-наборами:

| Где | Иконка | Соответствие |
|---|---|---|
| `popup.html`, `panel.html` | фирменный знак, `viewBox 0 0 17.32 17.32` | **не** из Lucide/Feather |
| `popup.html` | `external-link` | контуры совпадают с upstream |
| `popup.html` | `check` | контуры совпадают с upstream |
| `popup.html` | `arrow-up-right` | контуры совпадают с upstream |
| `panel.html` ×2 | `search` | контуры совпадают с upstream (редакция Lucide) |
| `popup.html` | глобус | тот же набор по рисунку, но контуры **перерисованы**, побайтового совпадения нет |

`external-link`, `check`, `arrow-up-right` и `search` входят в список иконок,
которые Lucide явно объявляет производными от Feather, — поэтому к ним
применимы **обе** лицензии ниже. Фирменный знак к этим наборам не относится:
`logos/white.svg` — собственная работа владельца проекта (подтверждено владельцем
2026-10-10), сторонних лицензий не несёт.

### 1.1 Lucide — ISC

Источник: <https://github.com/lucide-icons/lucide/blob/main/LICENSE>
(получено 2026-09-20; та же лицензия опубликована на <https://lucide.dev/license>).

```
ISC License

Copyright (c) 2026 Lucide Icons and Contributors

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
```

### 1.2 Feather-производные иконки — MIT (в редакции файла Lucide)

Тот же файл `LICENSE` Lucide содержит отдельный раздел для иконок,
унаследованных от Feather. Приведён целиком, включая его вводную строку:

```
The following Lucide icons are derived from the Feather project:

airplay, alert-circle, alert-octagon, alert-triangle, aperture,
arrow-down-circle, arrow-down-left, arrow-down-right, arrow-down,
arrow-left-circle, arrow-left, arrow-right-circle, arrow-right,
arrow-up-circle, arrow-up-left, arrow-up-right, arrow-up, at-sign, calendar,
cast, check, chevron-down, chevron-left, chevron-right, chevron-up,
chevrons-down, chevrons-left, chevrons-right, chevrons-up, circle, clipboard,
clock, code, columns, command, compass, corner-down-left, corner-down-right,
corner-left-down, corner-left-up, corner-right-down, corner-right-up,
corner-up-left, corner-up-right, crosshair, database, divide-circle,
divide-square, dollar-sign, download, external-link, feather, frown, hash,
headphones, help-circle, info, italic, key, layout, life-buoy, link-2, link,
loader, lock, log-in, log-out, maximize, meh, minimize, minimize-2,
minus-circle, minus-square, minus, monitor, moon, more-horizontal,
more-vertical, move, music, navigation-2, navigation, octagon, pause-circle,
percent, plus-circle, plus-square, plus, power, radio, rss, search, server,
share, shopping-bag, sidebar, smartphone, smile, square, table-2, tablet,
target, terminal, trash-2, trash, triangle, tv, type, upload, x-circle,
x-octagon, x-square, x, zoom-in, zoom-out

The MIT License (MIT) (for the icons listed above)

Copyright (c) 2013-present Cole Bemis

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### 1.3 Feather — MIT (собственный файл проекта Feather)

Источник: <https://raw.githubusercontent.com/feathericons/feather/main/LICENSE>
(получено 2026-09-20). Отличается от предыдущего только годами в строке
copyright — приведён отдельно, чтобы уведомление совпадало с первоисточником:

```
The MIT License (MIT)

Copyright (c) 2013-2023 Cole Bemis

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## 2. Растровые иконки расширения

`icons/icon16.png`, `icons/icon48.png`, `icons/icon128.png`.

Растеризация знака проекта Thumb Sight — `logos/white.svg`, тот же знак, что в
`popup.html`, — на синей плашке `.brand-mark` из `popup.html`. Получены скриптом
`tools/render-extension-icons.mjs` основного репозитория (headless Chrome, без
npm-зависимостей) 2026-10-09; рендер детерминирован, хеши — в
`security/audit-2026-08-09/tasks/PUB-04-icons-provenance.md`. Сторонних
графических материалов, шаблонов и иконпаков в рендере нет; происхождение самого
знака — см. §1 (авторство подтверждает владелец). Иконки `extensions/admin/icons/`
— те же файлы побайтно.

## 3. Зависимости разработки

`playwright-core` (Apache-2.0), `pngjs` (MIT), `pixelmatch` (ISC). Ставятся
только для локальных браузерных проверок, в расширение и в установочный пакет
не попадают, поэтому их тексты здесь не дублируются: после `npm ci` они лежат
в `node_modules`. Названия лицензий взяты из метаданных пакетов в
`package-lock.json`, отдельной сверкой с upstream не подтверждались.

## 4. Границы этого файла

Проверено только перечисленное выше, методом сверки контуров и чтения
первичных файлов лицензий. Авторство прочих изображений, шрифтов и текстов
продукта здесь не устанавливалось.
