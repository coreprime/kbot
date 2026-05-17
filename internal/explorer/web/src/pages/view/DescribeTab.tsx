import { useAsync } from '../../hooks'
import { Loading, ErrorMsg } from '../../components/Loading'
import MetadataTree from '../../components/MetadataTree'

export default function DescribeTab({ filePath }: { filePath: string }) {
  const { data, loading, error } = useAsync(async () => {
    const res = await fetch(`/api/describe/${filePath.replace(/^\/+/, '')}`)
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
    return res.json()
  }, [filePath])

  if (loading) return <Loading />
  if (error) return <ErrorMsg message={error} />
  if (!data) return null

  return <MetadataTree data={data} defaultOpen={true} />
}
