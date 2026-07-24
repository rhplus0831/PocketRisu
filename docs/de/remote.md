<p align="center">
  <a href="../en/remote.md">English</a> | <a href="../ko/remote.md">한국어</a> | <strong>Deutsch</strong> | <a href="../cn/remote.md">简体中文</a> | <a href="../es/remote.md">Español</a> | <a href="../vi/remote.md">Tiếng Việt</a> | <a href="../zh-Hant/remote.md">繁體中文</a>
</p>

# Fernzugriff-Leitfaden

> 🌐 Diese Anleitung wurde maschinell übersetzt. Für die genauesten Informationen siehe die [englische](../en/remote.md) oder [koreanische](../ko/remote.md) Version.

Verwenden Sie Tailscale, um von einem anderen Gerät (Smartphone, Tablet oder anderer PC) über HTTPS auf PocketRisu zuzugreifen, das auf Ihrem PC läuft.

## Tailscale

Erstellt ein privates Netzwerk (VPN), das nur von Geräten zugänglich ist, die mit demselben Konto angemeldet sind. Die URL bleibt über Server-Neustarts hinweg erhalten.

### Schritt 1: Tailscale installieren

- PC: [tailscale.com](https://tailscale.com/)
- Smartphone: Suchen Sie nach "Tailscale" im App Store / Google Play
- Anderer PC: Ebenso über [tailscale.com](https://tailscale.com/)

### Schritt 2: Mit demselben Konto anmelden

Melden Sie sich in der Tailscale-App auf dem PC und auf jedem Gerät, von dem Sie zugreifen möchten, mit demselben Konto (Google, Microsoft usw.) an.

### Schritt 3: HTTPS-Sharing auf dem PC aktivieren

Führen Sie im Terminal auf dem PC, auf dem PocketRisu läuft, einmal aus:

```bash
tailscale serve --bg http://localhost:6001
```

### Schritt 4: Von einem anderen Gerät zugreifen

Öffnen Sie in einem Browser mit diesem URL-Format:

```
https://ihr-pc-name.tail-irgendetwas.ts.net
```

Finden Sie die genaue Adresse über den Eintrag Ihres PCs in der Geräteliste der Tailscale-App. Setzen Sie ein Lesezeichen im Browser, sodass Sie ab dann nur den Server auf dem PC starten müssen, um von jedem Gerät aus zuzugreifen.


---

← [Zurück zur README](../../i18n/README.de.md)
