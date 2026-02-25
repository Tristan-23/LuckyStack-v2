import { apiRequest } from "@/_sockets/apiRequest"
import { useEffect } from "react"

export default function Home() {

  useEffect(() => {
    (async () => {
      const response = await apiRequest({ name: 'examples/adminOnly', version: "v1" })
    })()
  }, [])

  return (
    <div>home</div>
  )
}