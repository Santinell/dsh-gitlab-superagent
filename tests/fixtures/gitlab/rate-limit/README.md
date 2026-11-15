# GitLab rate-limit fixtures

Снято 2026-11-15 с GitLab 19.2.9.

| Файл | Что показывает |
| --- | --- |
| `issues-headers.txt` | обычный ответ issues: `X-Total`, `X-Page`, `X-Per-Page`, без `RateLimit-*` |
| `todos-headers.txt` | ответ `/todos`; `RateLimit-*` на стенде отсутствуют |
| `issues-per-page-101.txt` | `per_page=101` обрезан до `X-Per-Page: 100` |

`429` и `Retry-After` не проверялись, чтобы не выжигать лимит. Для источника: `per_page=100`, интервал не меньше 60 с, `updated_after`, backoff по `Retry-After`, если заголовок придёт.
