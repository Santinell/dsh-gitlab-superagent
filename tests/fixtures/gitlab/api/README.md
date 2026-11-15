# `glab api` fixtures

Снято 2026-11-15 с GitLab **19.2.9**, `glab` 1.121.0, проект `tlcamp/human-resources` (id 25).

| Файл | Что показывает |
| --- | --- |
| `issues-page.json` | одна страница списка: плоский JSON-массив |
| `issues-paginate-2pages.json` | сырой `--paginate` на двух страницах: два массива подряд, `][` без разделителя; как единый JSON не парсится |
| `issues-paginate.ndjson` | `--paginate --output ndjson`: один объект на строку, 2 строки |
| `issues.ndjson` | `--output ndjson` без пагинации |
| `issues-headers.txt` | `-i`: `X-Next-Page`, `X-Page`, `X-Per-Page`, `X-Total`, `X-Total-Pages`, `Link` |
| `error-404.json` | тело 404: `{"message":"404 Not found"}` |
| `error-404.stderr.txt` | stderr `glab: 404 Not found (HTTP 404)` |

## Вывод

Для пагинации использовать `--paginate --output ndjson`; `--paginate` без этого печатает конкатенированные массивы, и `JSON.parse`/`jq` читает только первый. Для одной страницы можно использовать обычный JSON-массив.
