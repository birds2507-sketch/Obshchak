# ОБЩАК 4.0 — миттєві FCM push

У застосунку підготовлено **FCM data-only push** через Firebase Cloud Messaging (HTTP v1).
Це **окрема функція від фонового опитування раз на ~15 хвилин**, яке залишається резервним.
FCM не потребує власного сервера: Google Apps Script надсилає FCM-повідомлення після запису події.

## 1. Створіть Firebase-проєкт (один раз)
1. Відкрийте https://console.firebase.google.com та створіть проєкт.
2. Додайте **Android app** із точним package name: `ua.obshchak.mobile`.
3. Завантажте `google-services.json` **лише на свій комп'ютер**. У GitHub його додавати не потрібно.
4. У Firebase/Google Cloud переконайтесь, що **Firebase Cloud Messaging API (HTTP v1)** увімкнено.

## 2. Налаштуйте збірку Android через GitHub Secrets
У репозиторії: **Settings → Secrets and variables → Actions → New repository secret**.

Візьміть відповідні поля з `google-services.json`:

| Secret | Звідки брати |
|---|---|
| `OBSHCHAK_FCM_APP_ID` | `client[0].client_info.mobilesdk_app_id` (формат `1:...:android:...`) |
| `OBSHCHAK_FCM_API_KEY` | `client[0].api_key[0].current_key` |
| `OBSHCHAK_FCM_PROJECT_ID` | `project_info.project_id` |
| `OBSHCHAK_FCM_SENDER_ID` | `project_info.project_number` |

Після збереження всіх чотирьох параметрів перезапустіть `Build test Android APK` у
**Actions → Build test Android APK → Run workflow**.
Це створить APK, який справді ініціалізує Firebase і реєструє пристрої.

Ці 4 значення — **публічна конфігурація клієнта**, а не права відправляти push.
Ні паролі учасників, ні серверний JSON-ключ у APK не вбудовуються.

## 3. Налаштуйте Google Apps Script (сервер)
1. У Firebase console: **Project settings → Service accounts → Generate new private key**.
2. Отриманий JSON-файл з `private_key` **не відправляйте в чат, не додавайте в GitHub і не вставляйте в Android**.
3. У своєму **наявному** проєкті Google Apps Script: **Project Settings → Script Properties → Add script property**.
4. Property: `FCM_SERVICE_ACCOUNT_JSON`. Value: повний вміст JSON-файлу (один JSON-об'єкт).
   Граничний розмір окремої властивості Apps Script — 9 КБ.
5. В Apps Script замініть **лише** `Code.gs` на нову версію з GitHub; `Index.html` не зачіпайте.
   **Не запускати `setupOwner_()` або `initializeObshchak()` повторно!**
6. Виберіть безпечну перевірку `checkFirebasePush_` у редакторі й натисніть **Run/Выполнить**.
   Вона лише перевіряє OAuth FCM, не змінює касу. Якщо попросять доступ до зовнішніх запитів —
   авторизуйте свій скрипт.
7. **Deploy → Manage deployments → Edit поточного розгортання → New version → Deploy**.
   Не створюйте нове розгортання: адреса `/exec` повинна залишитися незмінною.

## 4. Тест
1. Встановіть оновлений APK на два Android-телефони, увійдіть **різними користувачами**.
2. Дозвольте системні сповіщення Android.
3. На першому телефоні опублікуйте коментар щодо витрати. На другому телефоні, навіть якщо
   застосунок у фоні, має з'явитися сповіщення **«Нове запитання або відповідь»**.
4. Перевірте, що сповіщення не дублюються з резервною фоновою перевіркою.
5. При виході з облікового запису на телефоні повідомлення на ньому не мають відображатися.

## Як це працює
- Android надсилає свій FCM device token лише після входу через індивідуальний обліковий запис.
- Apps Script зберігає прив'язку device token до конкретного учасника в аркуші `PushTokens`.
- Після запису події FCM отримують тільки інші **активні** учасники; автор події не отримує власне сповіщення.
- Передача надійного токена сервера йде через OAuth2 зі службовим обліковим записом.
- У push немає фотографій чеків, паролів чи файлів.
- Якщо Firebase не налаштовано або недоступний, фінансові записи працюють як і раніше, а
  резервна фонова перевірка подій раз на ~15 хвилин залишається доступною.

## Безпека
- Ключ `FCM_SERVICE_ACCOUNT_JSON` дає право **надсилати** push. Ставтеся до нього як до пароля.
- За можливості надайте службовому обліковому запису лише право `cloudmessaging.messages.create`.
- Firebase доставляє повідомлення зазвичай оперативно, але абсолютно гарантованої миттєвості не існує
  (вимкнений інтернет, налаштування Android, стан пристрою).
- Публічний репозиторій GitHub не повинен містити секретних даних чи Google Sheets.
