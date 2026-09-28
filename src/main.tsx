// StatusFlare: extracted and adapted from the UptimeFlare full-stack derivative; see NOTICE.
import React, { lazy, Suspense } from 'react'
import { createRoot } from 'react-dom/client'
import { MantineProvider, Loader, Center } from '@mantine/core'
import '@mantine/core/styles.css'
import './style.css'
const PublicPage = lazy(() => import('./public'))
const Admin = lazy(() => import('./admin'))

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <MantineProvider
      defaultColorScheme="dark"
      theme={{
        primaryColor: 'teal',
        fontFamily: "'MiSans VF', sans-serif",
        headings: { fontFamily: "'MiSans VF', sans-serif" },
        defaultRadius: 'md',
        fontSizes: {
          xs: '0.875rem', // 14px
          sm: '1rem', // 16px
          md: '1.125rem', // 18px，默认正文字号
          lg: '1.25rem', // 20px
          xl: '1.375rem', // 22px
          xxl: '1.5rem', // 24px
          xxxl: '1.625rem', // 26px
          xxxxl: '1.75rem', // 28px
        },
      }}
    >
      <Suspense
        fallback={
          <Center h="100vh">
            <Loader />
          </Center>
        }
      >
        {window.location.pathname.startsWith('/admin') ? <Admin /> : <PublicPage />}
      </Suspense>
    </MantineProvider>
  </React.StrictMode>
)
