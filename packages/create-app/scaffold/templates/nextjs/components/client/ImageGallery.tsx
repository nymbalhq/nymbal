'use client'

import { useState } from 'react'
import Image from 'next/image'
import styles from '@/styles/pages/pdp.module.css'

interface GalleryImage {
  url: string
  alt: string
}

interface ImageGalleryProps {
  images: GalleryImage[]
}

export function ImageGallery({ images }: ImageGalleryProps) {
  const [selectedIndex, setSelectedIndex] = useState(0)

  if (images.length === 0) {
    return (
      <div className={styles.gallery} data-testid="product-gallery">
        <div className={styles.mainImage}>
          <span className="visually-hidden">No images available</span>
        </div>
      </div>
    )
  }

  const currentImage = images[selectedIndex]

  return (
    <div className={styles.gallery} data-testid="product-gallery">
      <div className={styles.mainImage}>
        <Image
          src={currentImage.url}
          alt={currentImage.alt}
          width={600}
          height={600}
          sizes="(max-width: 1023px) 100vw, 50vw"
          priority
        />
      </div>
      {images.length > 1 && (
        <div className={styles.thumbnails} role="list">
          {images.map((image, index) => (
            <button
              key={index}
              type="button"
              className={`${styles.thumbnail} ${
                index === selectedIndex ? styles.thumbnailActive : ''
              }`}
              onClick={() => setSelectedIndex(index)}
              aria-label={`View image ${index + 1}`}
              aria-current={index === selectedIndex ? 'true' : undefined}
            >
              <Image
                src={image.url}
                alt={image.alt}
                width={80}
                height={80}
              />
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
