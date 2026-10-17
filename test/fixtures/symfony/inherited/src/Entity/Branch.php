<?php

namespace App\Entity;

use App\Entity\Traits\Owned;
use Doctrine\ORM\Mapping as ORM;

#[ORM\Entity]
class Branch
{
    use Owned;

    #[ORM\Id]
    #[ORM\GeneratedValue]
    #[ORM\Column]
    private ?int $id = null;
}
