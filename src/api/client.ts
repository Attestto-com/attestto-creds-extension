import axios from 'axios'

const baseURL = import.meta.env.VITE_API_URL || 'http://localhost:3333/api'

export const apiClient = axios.create({
  baseURL,
  withCredentials: true,
  headers: {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  },
})

// CSRF token interceptor — reads from cookie set by the API
apiClient.interceptors.request.use((config) => {
  const csrfToken = document.cookie
    .split('; ')
    .find((row) => row.startsWith('XSRF-TOKEN='))
    ?.split('=')[1]

  if (csrfToken) {
    config.headers['X-XSRF-TOKEN'] = decodeURIComponent(csrfToken)
  }

  return config
})

// 401 interceptor — send message to background to clear session
apiClient.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
      chrome.runtime.sendMessage({ type: 'SESSION_EXPIRED' }).catch(() => {
        // Background may not be listening yet
      })
    }
    return Promise.reject(error)
  },
)
