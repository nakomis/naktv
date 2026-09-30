/*
 * goopng: round-trip an Elegoo .goo through full-resolution layer images.
 *
 *   goopng goo2png in.goo DIR          every layer -> DIR/NNNN.png (1-bit, as the LCD shows it)
 *   goopng png2goo in.goo DIR out.goo  DIR/NNNN.png -> a new .goo
 *
 * png2goo takes only the file header from in.goo (thumbnails and print
 * settings: metadata a pirate would type in from the printer profile). Each
 * layer's 66-byte definition is generated from those settings, not copied,
 * and each layer's image comes from the PNG.
 *
 * Black-and-white layers only: that is what Chitubox wrote (no anti-aliasing).
 */
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <zlib.h>

#define SETTINGS (194 + 116 * 116 * 2 + 2 + 290 * 290 * 2 + 2)
#define DEF_BYTES 66
#define TRANSITION_LAYERS 5

static uint32_t be32(const uint8_t *p) { return (uint32_t)p[0] << 24 | p[1] << 16 | p[2] << 8 | p[3]; }
static uint16_t be16(const uint8_t *p) { return (uint16_t)(p[0] << 8 | p[1]); }
static float bef(const uint8_t *p) { uint32_t u = be32(p); float f; memcpy(&f, &u, 4); return f; }
static void put32(uint8_t *p, uint32_t v) { p[0] = v >> 24; p[1] = v >> 16; p[2] = v >> 8; p[3] = v; }
static void putf(uint8_t *p, float f) { uint32_t u; memcpy(&u, &f, 4); put32(p, u); }

static void die(const char *m) { fprintf(stderr, "%s\n", m); exit(1); }

static uint8_t *slurp(const char *path, size_t *len) {
  FILE *f = fopen(path, "rb");
  if (!f) die(path);
  fseek(f, 0, SEEK_END); *len = ftell(f); fseek(f, 0, SEEK_SET);
  uint8_t *b = malloc(*len);
  if (fread(b, 1, *len, f) != *len) die("short read");
  fclose(f);
  return b;
}

/* Decode one layer's runs into px (one byte per pixel, 0 or 1). */
static void decode(const uint8_t *d, uint32_t size, uint8_t *px, size_t total, int layer) {
  if (d[0] != 0x55) { fprintf(stderr, "layer %d: no 0x55\n", layer); exit(1); }
  unsigned sum = 0;
  for (uint32_t i = 1; i < size - 1; i++) sum += d[i];
  if ((uint8_t)~sum != d[size - 1]) { fprintf(stderr, "layer %d: checksum\n", layer); exit(1); }
  size_t pixel = 0;
  for (uint32_t i = 1; i < size - 1; i++) {
    uint8_t b = d[i];
    int type = b >> 6, extra = (b >> 4) & 3;
    if (type == 1 || type == 2) { fprintf(stderr, "layer %d: grey/step run, not handled\n", layer); exit(1); }
    size_t high = 0;
    for (int k = 0; k < extra; k++) high = high << 8 | d[++i];
    size_t len = high * 16 + (b & 0x0f);
    if (pixel + len > total) { fprintf(stderr, "layer %d: too many pixels\n", layer); exit(1); }
    memset(px + pixel, type == 3, len);
    pixel += len;
  }
  if (pixel != total) { fprintf(stderr, "layer %d: %zu pixels, expected %zu\n", layer, pixel, total); exit(1); }
}

/* Encode px back into runs. Returns the size written to out. */
static size_t encode(const uint8_t *px, size_t total, uint8_t *out) {
  size_t o = 0;
  out[o++] = 0x55;
  unsigned sum = 0;
  size_t p = 0;
  while (p < total) {
    uint8_t v = px[p];
    size_t start = p;
    while (p < total && px[p] == v) p++;
    size_t len = p - start, high = len / 16;
    int extra = high == 0 ? 0 : high < 0x100 ? 1 : high < 0x10000 ? 2 : 3;
    uint8_t lead = (uint8_t)((v ? 3 : 0) << 6 | extra << 4 | (len & 0x0f));
    out[o++] = lead; sum += lead;
    for (int k = extra - 1; k >= 0; k--) { uint8_t hb = (high >> (8 * k)) & 0xff; out[o++] = hb; sum += hb; }
  }
  out[o++] = (uint8_t)~sum;
  return o;
}

/* --- minimal 1-bit greyscale PNG, one IDAT, filter 0 --- */
static void chunk(FILE *f, const char *type, const uint8_t *data, uint32_t len) {
  uint8_t h[8]; put32(h, len); memcpy(h + 4, type, 4);
  fwrite(h, 1, 8, f); if (len) fwrite(data, 1, len, f);
  uLong c = crc32(0, (const Bytef *)type, 4); c = crc32(c, data, len);
  uint8_t cb[4]; put32(cb, (uint32_t)c); fwrite(cb, 1, 4, f);
}

static void write_png(const char *path, const uint8_t *px, int w, int h, uint8_t *raw, uint8_t *z, uLong zcap) {
  size_t rb = (w + 7) / 8;
  for (int y = 0; y < h; y++) {
    uint8_t *row = raw + y * (rb + 1);
    row[0] = 0;
    memset(row + 1, 0, rb);
    const uint8_t *s = px + (size_t)y * w;
    for (int x = 0; x < w; x++) if (s[x]) row[1 + x / 8] |= 0x80 >> (x & 7);
  }
  uLongf zl = zcap;
  if (compress2(z, &zl, raw, (uLong)h * (rb + 1), 6) != Z_OK) die("compress");
  FILE *f = fopen(path, "wb");
  if (!f) die(path);
  static const uint8_t sig[8] = {137, 80, 78, 71, 13, 10, 26, 10};
  fwrite(sig, 1, 8, f);
  uint8_t ihdr[13]; put32(ihdr, w); put32(ihdr + 4, h);
  ihdr[8] = 1; ihdr[9] = 0; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  chunk(f, "IHDR", ihdr, 13);
  chunk(f, "IDAT", z, (uint32_t)zl);
  chunk(f, "IEND", NULL, 0);
  fclose(f);
}

static void read_png(const char *path, uint8_t *px, int w, int h, uint8_t *raw) {
  size_t len; uint8_t *b = slurp(path, &len);
  size_t rb = (w + 7) / 8, p = 8;
  uint8_t *idat = malloc(len); size_t il = 0;
  while (p + 8 <= len) {
    uint32_t cl = be32(b + p);
    const uint8_t *t = b + p + 4;
    if (!memcmp(t, "IHDR", 4) && (be32(b + p + 8) != (uint32_t)w || be32(b + p + 12) != (uint32_t)h || b[p + 16] != 1)) die("png: wrong shape");
    if (!memcmp(t, "IDAT", 4)) { memcpy(idat + il, b + p + 8, cl); il += cl; }
    p += 12 + cl;
  }
  uLongf rl = (uLong)h * (rb + 1);
  if (uncompress(raw, &rl, idat, il) != Z_OK || rl != (uLong)h * (rb + 1)) die("png: inflate");
  for (int y = 0; y < h; y++) {
    const uint8_t *row = raw + y * (rb + 1);
    if (row[0] != 0) die("png: unsupported filter");
    uint8_t *d = px + (size_t)y * w;
    for (int x = 0; x < w; x++) d[x] = (row[1 + x / 8] >> (7 - (x & 7))) & 1;
  }
  free(idat); free(b);
}

int main(int argc, char **argv) {
  if (argc < 4) die("usage: goopng goo2png in.goo DIR | goopng png2goo in.goo DIR out.goo");
  int to_png = !strcmp(argv[1], "goo2png");
  size_t len; uint8_t *g = slurp(argv[2], &len);
  const uint8_t *s = g + SETTINGS;
  uint32_t n = be32(s), table = be32(s + 160);
  int w = be16(s + 4), h = be16(s + 6);
  float lh = bef(s + 22), exp = bef(s + 26), bexp = bef(s + 59);
  uint32_t bn = be32(s + 63);
  size_t total = (size_t)w * h, rb = (w + 7) / 8;
  uint8_t *px = malloc(total), *raw = malloc((size_t)h * (rb + 1));
  uLong zcap = compressBound((uLong)h * (rb + 1));
  uint8_t *z = malloc(zcap), *enc = malloc(total * 2 + 16);
  char path[4096];
  fprintf(stderr, "%u layers, %dx%d, %.3f mm, %.2f s (bottom %u at %.2f s)\n", n, w, h, lh, exp, bn, bexp);

  if (to_png) {
    size_t off = table;
    for (uint32_t i = 0; i < n; i++) {
      uint32_t size = be32(g + off + DEF_BYTES);
      decode(g + off + DEF_BYTES + 4, size, px, total, i);
      snprintf(path, sizeof path, "%s/%04u.png", argv[3], i);
      write_png(path, px, w, h, raw, z, zcap);
      off += DEF_BYTES + 4 + size + 2;
      if (i % 500 == 0) fprintf(stderr, "  %u\n", i);
    }
    return 0;
  }

  if (argc < 5) die("png2goo needs out.goo");
  /* The constant part of every definition (lift and retract speeds, PWM...):
     profile settings, taken from the first layer's definition. */
  uint8_t tmpl[DEF_BYTES];
  memcpy(tmpl, g + table, DEF_BYTES);
  FILE *out = fopen(argv[4], "wb");
  if (!out) die(argv[4]);
  fwrite(g, 1, table, out); /* header: metadata */
  for (uint32_t i = 0; i < n; i++) {
    snprintf(path, sizeof path, "%s/%04u.png", argv[3], i);
    read_png(path, px, w, h, raw);
    uint8_t def[DEF_BYTES];
    memcpy(def, tmpl, DEF_BYTES);
    float zpos = (float)((i + 1) * (double)lh);
    float e = exp;
    if (i < bn) e = bexp;
    else if (i < bn + TRANSITION_LAYERS) e = bexp - (float)(i - bn + 1) * (bexp - exp) / (TRANSITION_LAYERS + 1);
    putf(def + 2, zpos); putf(def + 6, zpos); putf(def + 10, e);
    size_t size = encode(px, total, enc);
    uint8_t sz[4]; put32(sz, (uint32_t)size);
    fwrite(def, 1, DEF_BYTES, out); fwrite(sz, 1, 4, out); fwrite(enc, 1, size, out); fwrite("\r\n", 1, 2, out);
    if (i % 500 == 0) fprintf(stderr, "  %u\n", i);
  }
  /* The end marker. */
  static const uint8_t end[11] = {0, 0, 0, 7, 0, 0, 0, 0x44, 0x4c, 0x50, 0};
  fwrite(end, 1, 11, out);
  fclose(out);
  return 0;
}
