import React from 'react'

/**
 * onError handler for <img> elements: hides the broken image and shows
 * a placeholder sibling.
 */
export function handleImgError(e: React.SyntheticEvent<HTMLImageElement>) {
  e.currentTarget.classList.add('img-broken')
  const placeholder = e.currentTarget.parentElement?.querySelector('.broken-asset')
  if (placeholder) {
    (placeholder as HTMLElement).style.display = 'flex'
  }
}
