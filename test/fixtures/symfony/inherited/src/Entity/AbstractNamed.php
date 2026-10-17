<?php

namespace App\Entity;

use Doctrine\ORM\Mapping as ORM;

// Not mapped: Doctrine maps the fields its entity children can see (not the private ones)
abstract class AbstractNamed
{
    use HasCode;

    #[ORM\Column(length: 100)]
    protected ?string $name = null;

    #[ORM\Column]
    private ?string $secret = null;
}
