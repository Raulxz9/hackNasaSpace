# IRIS — Infrared Remote Incident System

Plataforma web progresiva (PWA) para el monitoreo global de anomalías térmicas e incendios activos con datos reales armonizados **MODIS + VIIRS** almacenados en **Google Cloud Storage** y detecciones casi en tiempo real de **NASA FIRMS** (`VIIRS_NOAA20_NRT`).

---

## Arquitectura del Repositorio

```text
/
├── backend/                  # API Node.js / Express (GCS + NASA FIRMS)
│   ├── server.js
│   ├── package.json
│   └── .env.example
├── frontend/                 # Angular + Ionic Framework (PWA + Mapbox GL JS)
│   ├── src/
│   │   ├── app/
│   │   │   ├── core/
│   │   │   │   ├── models/       # Interfaces TypeScript (Incendio, ResumenCalendario, Filtros...)
│   │   │   │   └── services/     # IncendiosApiService, MapboxService, I18nService, CsvExportService
│   │   │   ├── components/       # Navbar, MapGlobe, TimelineCalendar, FiltersPanel, MapSettingsPanel, RiskPredictionPanel, HotspotToast, FooterBar
│   │   │   └── home/             # Página principal Ionic
│   │   ├── assets/
│   │   ├── environments/         # environment.ts y environment.prod.ts
│   │   ├── manifest.webmanifest
│   │   └── theme/
│   ├── angular.json
│   ├── ngsw-config.json
│   └── package.json
└── README.md
```

---

## Requisitos Previos

- **Node.js** `>= 18` (probado en `v26.12.1`) y **npm**
- Credenciales de Google Cloud Storage (bucket `incendios-datos-bucket-2026` con CSVs históricos `YYYY_MM_Pais.csv` desde noviembre de 2000)
- Clave de API de NASA FIRMS (`NASA_MAP_KEY`) para sincronización en vivo
- Token público de Mapbox (`pk.ey...`)

---

## 1. Configuración y Ejecución del Backend (`backend/`)

1. Copia `.env.example` a `.env` dentro de `backend/` y configura tus credenciales:
   ```bash
   cd backend
   cp .env.example .env
   ```
   Variables esperadas en `backend/.env`:
   - `PORT=3000`
   - `BUCKET_NAME=incendios-datos-bucket-2026`
   - `GCP_CREDENTIALS_JSON=...` (o `GOOGLE_APPLICATION_CREDENTIALS`)
   - `NASA_MAP_KEY=...`

2. Instala dependencias y arranca el servidor:
   ```bash
   npm install
   node server.js
   ```

### Endpoints Disponibles

| Método | Ruta | Descripción |
| :--- | :--- | :--- |
| `GET` | `/` | Estado básico del servicio |
| `GET` | `/api/health` | Health check ligero (útil para despertar Render) |
| `GET` | `/api/incendios` | Consulta de focos armonizados por `fecha` (`YYYY-MM-DD`) o `mesConsulta` + `anioConsulta`, con filtros opcionales `pais`, `horaInicio`, `horaFin`, `limite`, bounding box (`north`, `south`, `east`, `west`), radio (`lat`, `lon`, `radioKm`) y exportación directa `?formato=csv` |
| `GET` | `/api/incendios/resumen` | Resumen ligero para la Línea del Tiempo (`anioConsulta` requerido, `mesConsulta` y `pais` opcionales): devuelve `resumenMensual`, `resumenDiario`, `diaPico`, `intensidadMaximaMes` y `medianaHistoricaMes` |

---

## 2. Configuración y Ejecución del Frontend PWA (`frontend/`)

1. Instala dependencias y ejecuta en modo desarrollo (apuntando a `http://localhost:3000`):
   ```bash
   cd frontend
   npm install
   npm start
   ```

2. Compilación de producción PWA (apunta a `https://hacknasaspace.onrender.com` y genera Service Worker `ngsw.json` + `manifest.webmanifest`):
   ```bash
   cd frontend
   npm run build
   ```
   Los archivos listos para servir se generan en `frontend/dist/iris-frontend/browser/`.

---

## Clasificación de Datos Reales en IRIS

- **Intensidad del incendio (FRP en MW)**:
  - **Bajo**: `frp < 15`
  - **Moderado**: `15 <= frp < 50`
  - **Alto**: `50 <= frp < 150`
  - **Crítico**: `150 <= frp < 400`
  - **Extremo**: `frp >= 400`
- **Origen del calor (determinista)**:
  - **Estático (fábricas)**: celdas de `0.02°` recurrentes en múltiples días distintos del mes (`>= 4` días) con baja dispersión de `frp`.
  - **Volcán activo**: zonas volcánicas conocidas o anomalías recurrentes de alta energía (`frp >= 120`).
  - **Mar (derrame de petróleo)**: coordenadas en zonas marinas/offshore petroleras (Sonda de Campeche, Mar del Norte, Golfo Pérsico, etc.).
  - **Vegetación**: resto de anomalías térmicas terrestres.
