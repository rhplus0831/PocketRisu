<p align="center">
  <a href="../en/remote.md">English</a> | <a href="../ko/remote.md">한국어</a> | <a href="../de/remote.md">Deutsch</a> | <a href="../cn/remote.md">简体中文</a> | <strong>Español</strong> | <a href="../vi/remote.md">Tiếng Việt</a> | <a href="../zh-Hant/remote.md">繁體中文</a>
</p>

# Guía de acceso remoto

> 🌐 Esta guía está traducida por máquina. Para obtener la información más precisa, consulte la versión en [inglés](../en/remote.md) o [coreano](../ko/remote.md).

Usa Tailscale para acceder mediante HTTPS a PocketRisu, que se ejecuta en tu PC, desde otro dispositivo (smartphone, tablet u otro PC).

## Tailscale

Construye una red privada (VPN) accesible solo desde dispositivos conectados con la misma cuenta. La URL persiste a través de reinicios del servidor.

### Paso 1: Instalar Tailscale

- PC: [tailscale.com](https://tailscale.com/)
- Smartphone: Busca "Tailscale" en App Store / Google Play
- Otro PC: Igualmente desde [tailscale.com](https://tailscale.com/)

### Paso 2: Iniciar sesión con la misma cuenta

Inicia sesión en la app de Tailscale en el PC y en cada dispositivo desde el que quieras acceder, usando la misma cuenta (Google, Microsoft, etc.).

### Paso 3: Habilitar compartir HTTPS en el PC

En el terminal del PC que ejecuta PocketRisu, ejecuta una vez:

```bash
tailscale serve --bg http://localhost:6001
```

### Paso 4: Acceder desde otro dispositivo

Abre en un navegador con este formato de URL:

```
https://nombre-de-mi-pc.tail-algo.ts.net
```

Encuentra la dirección exacta a través de la entrada de tu PC en la lista de dispositivos de la app de Tailscale. Agrega a marcadores del navegador, y a partir de entonces solo necesitas iniciar el servidor en el PC para acceder desde cualquier dispositivo.


---

← [Volver al README](../../i18n/README.es.md)
