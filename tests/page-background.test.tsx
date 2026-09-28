// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import PageBackground from '../src/page-background'

afterEach(cleanup)
it('loads with CORS and a per-image referrer policy, and falls back on failure', () => {
  const { container, rerender } = render(
    <PageBackground url="https://images.example.com/a.jpg" dim={0} />
  )
  const image = container.querySelector('img')!
  expect(image.getAttribute('crossorigin')).toBe('anonymous')
  expect(image.getAttribute('referrerpolicy')).toBe('strict-origin-when-cross-origin')
  expect(image.alt).toBe('')
  expect((container.firstChild as HTMLElement).style.opacity).toBe('0')
  fireEvent.load(image)
  expect((container.firstChild as HTMLElement).style.opacity).toBe('1')
  expect((container.querySelector('.page-background-shade') as HTMLElement).style.opacity).toBe('0')
  rerender(<PageBackground url="https://images.example.com/a.jpg" dim={1} />)
  expect((container.querySelector('.page-background-shade') as HTMLElement).style.opacity).toBe('1')
  rerender(<PageBackground url="https://images.example.com/b.jpg" dim={0.6} />)
  expect((container.firstChild as HTMLElement).style.opacity).toBe('0')
  fireEvent.error(container.querySelector('img')!)
  expect((container.firstChild as HTMLElement).style.opacity).toBe('0')
  rerender(<PageBackground url="" />)
  expect(container.childElementCount).toBe(0)
})
