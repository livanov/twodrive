"use strict";
/* Declarative fake OneDrive tree.
 *
 *   const d = buildDrive([
 *     folder("Camera Roll", [ image("IMG_1.jpg", { taken: "2024-05-01T10:00:00Z" }) ]),
 *     image("root.jpg"),
 *     file("notes.txt", "text/plain"),
 *   ]);
 *
 * buildDrive() returns the Graph-shaped listings the mock serves:
 *   d.children(id)  -> array of driveItem JSON for that folder
 *   d.itemsById     -> Map of every item
 *   d.imageCount    -> images that the app should be able to display
 *   d.folderIdByName / d.folderPathByName / d.imageByName
 */

const ROOT_PATH = "/drive/root:";
const THUMB_HOST = "https://thumbs.example";
const DL_HOST = "https://dl.example";

let _seq = 0;
const nextId = (p) => `${p}${++_seq}`;

/* ---- spec node constructors (plain descriptors, resolved by buildDrive) ---- */
const folder = (name, children = [], opts = {}) => ({ kind: "folder", name, children, ...opts });
const image = (name, opts = {}) => ({ kind: "image", name, ...opts });
const file = (name, mimeType = "text/plain", opts = {}) => ({ kind: "file", name, mimeType, ...opts });
const nomedia = () => file(".nomedia", "application/octet-stream");

function thumbSet(id, tag) {
  const u = (size) => `${THUMB_HOST}/t/${id}-${size}${tag ? "-" + tag : ""}.png`;
  return [{ id: "0", small: { url: u("s") }, medium: { url: u("m") }, large: { url: u("l") } }];
}

function buildDrive(spec) {
  _seq = 0;
  const itemsById = new Map();
  const childrenById = new Map();
  const folderIdByName = new Map();
  const folderPathByName = new Map();
  const imageByName = new Map();
  let imageCount = 0;

  folderIdByName.set("root", "root");
  folderPathByName.set("root", ROOT_PATH);

  const walk = (nodes, parentId, parentPath) => {
    const out = [];
    childrenById.set(parentId, out);
    for (const n of nodes) {
      if (n.kind === "folder") {
        const id = n.id || nextId("f");
        const path = parentPath + "/" + n.name;
        const item = {
          id,
          name: n.name,
          size: 0,
          folder: { childCount: n.childCount != null ? n.childCount : n.children.length },
          parentReference: { driveId: "drive1", id: parentId, path: parentPath },
          lastModifiedDateTime: n.modified || "2024-01-01T00:00:00Z",
        };
        out.push(item);
        itemsById.set(id, item);
        folderIdByName.set(n.name, id);
        folderPathByName.set(n.name, path);
        walk(n.children, id, path);
      } else if (n.kind === "image") {
        const id = n.id || nextId("i");
        const item = {
          id,
          name: n.name,
          size: n.size != null ? n.size : 1000 + _seq,
          file: { mimeType: n.mimeType || "image/jpeg" },
          image: { width: 4000, height: 3000 },
          photo: n.taken === null ? undefined : { takenDateTime: n.taken || "2024-01-01T00:00:00Z" },
          fileSystemInfo: { createdDateTime: n.taken || "2024-01-01T00:00:00Z" },
          lastModifiedDateTime: n.taken || "2024-01-01T00:00:00Z",
          parentReference: { driveId: "drive1", id: parentId, path: parentPath },
          thumbnails: n.noThumb ? [] : thumbSet(id, n.thumbTag),
          "@microsoft.graph.downloadUrl": `${DL_HOST}/d/${id}.jpg`,
        };
        if (!item.photo) delete item.photo;
        out.push(item);
        itemsById.set(id, item);
        imageByName.set(n.name, item);
        if (!n.noThumb) imageCount++;
      } else {
        const id = n.id || nextId("x");
        const item = {
          id,
          name: n.name,
          size: n.size != null ? n.size : 12,
          file: { mimeType: n.mimeType },
          parentReference: { driveId: "drive1", id: parentId, path: parentPath },
          lastModifiedDateTime: "2024-01-01T00:00:00Z",
        };
        out.push(item);
        itemsById.set(id, item);
      }
    }
    return out;
  };

  walk(spec, "root", ROOT_PATH);

  return {
    ROOT_PATH,
    itemsById,
    childrenById,
    folderIdByName,
    folderPathByName,
    imageByName,
    imageCount,
    children(id) { return childrenById.get(id) || []; },
    idOf(name) { return folderIdByName.get(name); },
    pathOf(name) { return folderPathByName.get(name); },
    /* a shallow clone of an image item, for use in delta payloads */
    imageItem(name) { return JSON.parse(JSON.stringify(imageByName.get(name))); },
  };
}

module.exports = {
  buildDrive, folder, image, file, nomedia,
  ROOT_PATH, THUMB_HOST, DL_HOST, thumbSet,
};
