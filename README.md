# migrate-phone-pc

Move photos, videos and files between your phone and your PC over Wi-Fi. No app on the phone, no cable, no cloud: the PC runs a small web server, you scan a QR code, and the phone uses the page in its browser.

Works with **iPhone (Safari)** and **Android (Chrome)**. The PC side is built for **Windows**.

## Features

**Phone → PC**
- Pick photos, videos or files on the phone and send them to the PC
- Built for big transfers (100 GB+): files go in 8 MB chunks and resume after Wi-Fi drops
- Files already on the PC are skipped, so re-selecting a batch is safe
- Photos and videos are sorted into `Photos/YYYY/MM/` by the date they were taken; other files go to `Files/`
- Nothing is overwritten: duplicate names become `IMG_0001 (1).HEIC`

**PC → phone**
- Choose files on the PC in the normal Explorer window; they appear on the phone under **Get from PC**
- Download one file, or select several and download them all
- With the optional HTTPS setup, **Save to Photos** puts photos and videos straight into the phone's photo library

**PC dashboard**
- QR code for the phone, live progress and speed, free disk space
- Previews of photos and videos in every list
- Choose where received files are saved

## Requirements

- Windows 10/11 (the dashboard's file and folder pickers are Windows-only; transfers themselves work on any OS)
- Node.js 20 or newer
- Phone and PC on the same Wi-Fi network

## Getting started

```bash
npm install
npm start
```

The dashboard opens in your browser at `http://localhost:8080/dashboard`. Scan its QR code with the phone camera.

The first time, Windows Firewall asks whether to allow Node.js. Allow it on **Private networks**, and make sure your Wi-Fi is set to Private (Settings → Network & Internet → Wi-Fi).

## Usage

### Send from phone to PC
1. Open the page on the phone (scan the QR code).
2. Tap **Choose photos, videos or files** and pick a batch. Batches of a few hundred items work best.
3. Keep the page open and the screen on until it finishes.
   - iPhone: Settings → Display & Brightness → Auto-Lock → Never
   - Android: Settings → Display → Screen timeout → longest

### Send from PC to phone
1. On the dashboard, under **Send to phone**, click **Add files…** and choose files.
2. On the phone, open the **Get from PC** tab.
3. Tap **Download** on a file, or select several and tap **Download N files**.

Where downloads go:
- **iPhone:** Files app › Downloads. To move them into Photos: in Files, tap ⋯ → Select, pick the files, tap Share → **Save N Items**.
- **Android:** the Downloads folder; photos and videos also show up in the gallery.

### Save to Photos (optional, one-time setup)

Phone browsers only allow a page to hand files to the photo library over HTTPS. The server can provide HTTPS using its own certificate, which the phone has to trust once:

1. On the phone page, tap **Want a Save to Photos button? One-time setup →**.
2. Follow the steps: download the certificate, install it, and on iPhone switch it on under Settings › General › About › Certificate Trust Settings.
3. Tap **Test and continue**.

From then on the QR code opens the secure page automatically. In **Get from PC**, select photos and videos, tap **Prepare for Photos**, then **Save to Photos**.

The certificate is created on your PC (in `certs/`) and only identifies this PC. To remove it from the phone later:
- iPhone: Settings › General › VPN & Device Management › Phone Transfer CA › Remove Profile
- Android: Settings › Security › Encryption & credentials › User credentials

## Configuration

| Setting | How | Default |
|---|---|---|
| Save folder | Dashboard → **Saving to**, or `npm start -- D:\Phone-Backup` | `./received` |
| HTTP port | `PORT` environment variable | `8080` |
| HTTPS port | `HTTPS_PORT` environment variable | `8443` |
| Don't open the dashboard on start | `NO_OPEN=1` | opens it |

A save folder given on the command line overrides the one chosen in the dashboard. The dashboard's choice is remembered in `settings.json`.

## Security

- The phone page needs a random access code that's part of the QR link. It changes every time the server starts.
- The dashboard only works on the PC itself (`localhost`).
- Only files you explicitly add under **Send to phone** can be downloaded.
- Everything stays on your local network.

Stop the server (Ctrl+C) when you're done.

## Limitations

- **iPhone may convert photos.** When picking from the photo library, iOS often converts HEIC photos to JPEG and sends Live Photos as stills only.
- **Some previews on the PC:** Chrome on Windows usually can't display HEIC photos or iPhone HEVC videos, so those show their file type instead of a picture.
- **Video dates:** videos are sorted by the date the phone reports, not by metadata inside the file.
- **Save to Photos** loads files into the phone's memory first, so it's limited to about 1.5 GB per batch. Use Download for very large videos.
- **Many downloads at once:** Chrome asks once to allow multiple downloads; Safari may ask for each file.

## Project structure

```
src/
  index.ts      HTTP/HTTPS server, routes, dashboard API
  store.ts      resumable uploads and the list of received files
  organize.ts   sorting into Photos/YYYY/MM by EXIF date
  outbox.ts     files offered to the phone, downloads and previews
  picker.ts     native Windows file/folder picker
  certs.ts      local certificate authority for HTTPS
public/
  index.html      phone page
  dashboard.html  PC dashboard
  setup.html      one-time HTTPS setup on the phone
```

Not in git: `received/` (your files), `certs/` (certificates and private keys), `settings.json`, `dist/`.
