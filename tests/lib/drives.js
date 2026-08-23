"use strict";
/* Reusable fake drives, described with the fixture DSL. */
const { buildDrive, folder, image, file, nomedia } = require("./fixtures");

/* 5 displayable images across 3 nested folders, plus noise the app must ignore:
 *   /                         root-jun.jpg (2024-06-15), readme.txt
 *   /Pictures                 p1.jpg (2024-05-02), p2.jpg (2023-11-20)
 *   /Pictures/Camera Roll     c1.jpg (2025-01-05), c2.jpg (2022-07-04)
 *   /Documents                notes.txt            (no images)
 *   /Empty                    (childCount 0)
 */
function demoDrive() {
  return buildDrive([
    image("root-jun.jpg", { taken: "2024-06-15T09:00:00Z", size: 111 }),
    file("readme.txt"),
    folder("Pictures", [
      image("p1.jpg", { taken: "2024-05-02T09:00:00Z", size: 222 }),
      image("p2.jpg", { taken: "2023-11-20T09:00:00Z", size: 333 }),
      folder("Camera Roll", [
        image("c1.jpg", { taken: "2025-01-05T09:00:00Z", size: 444 }),
        image("c2.jpg", { taken: "2022-07-04T09:00:00Z", size: 555 }),
      ]),
    ]),
    folder("Documents", [file("notes.txt")]),
    folder("Empty", []),
  ]);
}

/* Root + two sibling branches, each with its own sub-folder — the shape the
 * resume test needs (a level-2 frontier of exactly two folders). */
function twoBranchDrive() {
  return buildDrive([
    folder("Alpha", [
      image("a1.jpg", { taken: "2024-03-01T00:00:00Z" }),
      folder("AlphaSub", [image("a2.jpg", { taken: "2024-03-02T00:00:00Z" })]),
    ]),
    folder("Beta", [
      image("b1.jpg", { taken: "2024-04-01T00:00:00Z" }),
      folder("BetaSub", [image("b2.jpg", { taken: "2024-04-02T00:00:00Z" })]),
    ]),
  ]);
}

/* A .nomedia folder with a sub-folder, so subtree exclusion is observable. */
function nomediaDrive() {
  return buildDrive([
    image("keep.jpg", { taken: "2024-06-01T00:00:00Z" }),
    folder("Visible", [image("vis.jpg", { taken: "2024-05-01T00:00:00Z" })]),
    folder("Hidden", [
      nomedia(),
      image("nm1.jpg", { taken: "2024-04-01T00:00:00Z" }),
      folder("HiddenSub", [image("nm2.jpg", { taken: "2024-03-01T00:00:00Z" })]),
    ]),
  ]);
}

module.exports = { demoDrive, twoBranchDrive, nomediaDrive };
