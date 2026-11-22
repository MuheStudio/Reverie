'use strict';

/*
 * New implementation from the supplied resource result contract and WHATWG
 * HTML/URL documentation (consulted 2026-10-05):
 * https://html.spec.whatwg.org/multipage/media.html#dom-media-currentsrc
 * https://html.spec.whatwg.org/multipage/embedded-content.html#the-source-element
 * https://html.spec.whatwg.org/multipage/embedded-content.html#dom-img-naturalwidth
 * https://url.spec.whatwg.org/#dom-url-pathname
 * Synthetic DOM fixtures only; no prior/upstream extraction code consulted.
 * This is not a legal clean-room claim. The repository is licensed under
 * Apache-2.0.
 */

// Keep the function self-contained: its exact source is the static browser
// script below. Page-derived data is never interpolated into executable code.
function collectResources(document) {
  const maximumResults = 1000;
  const maximumNodes = 10000;
  const maximumURLLength = 2048;
  const maximumTitleLength = 4096;
  const maximumTypeLength = 256;
  const resources = [];
  const title = typeof document.title === 'string' ? document.title.slice(0, maximumTitleLength) : '';
  let visited = 0;

  function append(url, type, resourceTitle, size) {
    // Never truncate a URL: that could identify a different resource.
    if (resources.length >= maximumResults || typeof url !== 'string' || !url || url.length > maximumURLLength) return;
    const entry = {
      url,
      type: type.slice(0, maximumTypeLength),
      title: resourceTitle.slice(0, maximumTitleLength),
    };
    if (size !== undefined) entry.size = size;
    resources.push(entry);
  }

  const mediaElements = document.querySelectorAll('video,audio');
  for (let index = 0; index < mediaElements.length && resources.length < maximumResults && visited < maximumNodes; index++) {
    visited++;
    const element = mediaElements[index];
    append(element.currentSrc || element.src, element.tagName.toLowerCase(), title);
    const sources = element.querySelectorAll('source');
    for (let sourceIndex = 0; sourceIndex < sources.length && resources.length < maximumResults && visited < maximumNodes; sourceIndex++) {
      visited++;
      const source = sources[sourceIndex];
      append(source.src, source.type || 'media', title);
    }
  }

  if (resources.length >= maximumResults || visited >= maximumNodes) return resources;
  const images = document.querySelectorAll('img');
  for (let index = 0; index < images.length && resources.length < maximumResults && visited < maximumNodes; index++) {
    visited++;
    const image = images[index];
    if (!(image.naturalWidth > 100)) continue;
    const url = image.src;
    if (typeof url !== 'string' || !url || url.length > maximumURLLength) continue;
    let extension = 'jpg';
    try {
      const pathname = new URL(url, document.baseURI).pathname;
      const match = /\.([a-z0-9]{1,16})$/i.exec(pathname);
      if (match) extension = match[1].toLowerCase();
    } catch {
      // A malformed DOM URL does not warrant executing a different parser.
      // It remains data for the caller's URL policy, with the default subtype.
    }
    const width = Number(image.width);
    const height = Number(image.height);
    const area = width * height;
    const size = width >= 0 && height >= 0 && Number.isFinite(area) ? area : 0;
    append(url, `image/${extension}`, image.alt || title, size);
  }
  return resources;
}

const collectResourcesScript = `(${collectResources.toString()})(document)`;

module.exports = { collectResources, collectResourcesScript };
