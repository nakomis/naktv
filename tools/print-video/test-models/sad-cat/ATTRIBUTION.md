# Sad cat

- **Model:** Sad cat, "sitting in a shower lamp, which kind of makes him even sadder"
- **By:** scoopydoopy, on Thingiverse: https://www.thingiverse.com/thing:3876635
- **Licence:** Creative Commons Public Domain Dedication (CC0). See `LICENSE.txt`,
  as downloaded. Credit is given anyway, as a courtesy.
- **Provenance:** sculpted from scratch in Blender (the uploader's own words in
  `README.txt`), so the CC0 is theirs to give. That's the reason it replaced
  DragonYoda, a mash-up of someone else's sculpt.

It's here for NAKTV-24: rebuilding a model on a coarse grid on purpose, for a
"built out of Lego" look. The model is an OBJ, which Chitubox opens directly.

## Furry variants

`sad-cat-fur.blend` adds fine detail to the model, for seeing what the layer
panel's resolution and blur do to it. Both variants are Geometry Nodes
modifiers with their settings exposed, so they can be tuned and re-exported:

- **`SadCat_Displaced`**: subdivided twice, then displaced along the normals by
  noise stretched in the fur's direction (±0.15 mm, strands ~0.2 mm wide).
- **`SadCat_Hair`** / **`SadCat_HairPrint`**: a hair (Curves) object growing
  ~59k tapered strands from the body, turned into tubes and joined to it.

There's also a half-size set (`SadCat_50_*`, ~5 cm tall, placed 90 mm along Y
so the two sets don't overlap) to cut print time. The fur there keeps the same
absolute size, not scaled with the cat: what matters is the fur against the
layer panel's grid and blur, so it's relatively twice as coarse.

| Export | Height | Faces | Size |
|---|---|---|---|
| `sad-cat-displaced.obj` | 100 mm | 3.5M | 225 MB |
| `sad-cat-hair.obj` | 103 mm | 2.1M | 145 MB |
| `sad-cat-50-displaced.obj` | 50 mm | 870k | 53 MB |
| `sad-cat-50-hair.obj` | 53 mm | 676k | 43 MB |

They're too big for GitHub, so they're gitignored and backed up on Leia at
`share/naktv/test-models/sad-cat/`. To rebuild one, show the object and use
File → Export → Wavefront (.obj) with *Apply Modifiers* and *Render*
evaluation. Move a whole set (body, hair and print objects) together: the
hair is positioned relative to its body, so moving one alone detaches it.

**Printing upright doesn't work for the hair**: resin builds up from the
plate, and drooping strands start at their tips, in thin air. Print them
upside down, head on the plate, so strands grow away from it. The hair
generator's *Min slope* (gravity) setting makes sure they do: any strand
shallower than that angle below horizontal is bent down to it, and hair on
the top of the head and back lies flat into the body. It's 45° on
`SadCat_50_Hair` and off (0) on the full-size one.

Print-ready files on Leia only, 41 mm × 1 mm disc under the head:
`sad-cat-50-inverted.obj`, `sad-cat-50-displaced-inverted.obj` and
`sad-cat-50-hair-gravity-inverted.obj` (the `-base` and plain
`-hair-inverted` ones are superseded).

The upright hair versions reach 2.5 mm below the base (hair under the paws and tail),
so cut at z = 0 before printing flat.

Fur grows on the eyes, bell and collar too, and the hair tips (0.1 mm) won't
survive washing. Neither matters here: the point is detail for the blur to eat.
