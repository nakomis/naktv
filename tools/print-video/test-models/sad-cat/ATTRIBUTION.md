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

The exports (`sad-cat-displaced.obj`, 225 MB; `sad-cat-hair.obj`, 145 MB) are
too big for GitHub, so they're gitignored and backed up on Leia at
`share/naktv/test-models/sad-cat/`. To rebuild one, show the object and use
File → Export → Wavefront (.obj) with *Apply Modifiers* and *Render* evaluation.

Fur grows on the eyes, bell and collar too, and the hair tips (0.1 mm) won't
survive washing. Neither matters here: the point is detail for the blur to eat.
